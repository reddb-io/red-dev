import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  runBounded,
  type BoundedCommandOptions,
  type BoundedCommandResult,
} from "./bounded-command.ts";

export type CacheKind =
  | "cargo-registry"
  | "cargo-git"
  | "cargo-target"
  | "npm"
  | "pnpm"
  | "pnpm-cache"
  | "bun";

export interface CacheObservation {
  kind: CacheKind;
  path: string;
  /** Physical bytes charged to the ext4 filesystem, as reported by du. */
  bytes: number | null;
  /** Null means inventory-only; Cargo performs its own global-cache GC. */
  argv: string[] | null;
  /** Configuration-sensitive commands must run where their path was resolved. */
  cwd?: string;
  note: string;
}

export interface CacheMaintenanceOutcome {
  kind: CacheKind;
  ok: boolean;
  freedBytes: number | null;
  detail: string;
}

export type CacheCommandRunner = (
  argv: string[],
  options?: BoundedCommandOptions,
) => Promise<BoundedCommandResult>;

export function isCacheMutatingProcess(process: { comm: string; argv: readonly string[] }): boolean {
  if (/^(?:cargo|rustc|rustdoc|sccache)$/i.test(process.comm)) return true;
  const command = process.argv.join(" ");
  return /(?:^|[\\/ ])(?:npm|pnpm)(?:\.c?js)?\b.*\b(?:install|add|update|remove|prune)\b/i.test(command) ||
    /(?:^|[\\/ ])bun\b.*\b(?:install|add|update|remove|pm\s+cache)\b/i.test(command);
}

interface PackageCacheOptions {
  env?: Record<string, string | undefined>;
  run?: CacheCommandRunner;
}

async function safely(
  run: CacheCommandRunner,
  argv: string[],
  options: BoundedCommandOptions = {},
): Promise<BoundedCommandResult | null> {
  try {
    return await run(argv, options);
  } catch {
    return null;
  }
}

function lastLine(value: string): string | null {
  const line = value.trim().split(/\r?\n/).filter(Boolean).at(-1)?.trim();
  if (!line || line.includes("\0") || line.includes("\n") || line.includes("\r")) return null;
  return line;
}

function absolutePath(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(value)) return null;
  return value.replace(/\\/g, "/").replace(/\/$/, "");
}

async function configuredPath(
  run: CacheCommandRunner,
  argv: string[],
  cwd?: string,
): Promise<string | null> {
  const result = await safely(run, argv, { cwd, timeoutMs: 5_000 });
  if (!result || result.timedOut || result.exitCode !== 0) return null;
  return absolutePath(lastLine(result.stdout));
}

export async function cacheUsageBytes(
  path: string,
  run: CacheCommandRunner = runBounded,
): Promise<number | null> {
  if (!existsSync(path)) return 0;
  const result = await safely(run, ["du", "-sk", "--", path], { timeoutMs: 30_000 });
  if (!result || result.timedOut || result.exitCode !== 0) return null;
  const kib = Number.parseInt(/^\s*(\d+)/.exec(result.stdout)?.[1] ?? "", 10);
  return Number.isSafeInteger(kib) && kib >= 0 ? kib * 1024 : null;
}

/**
 * Inventory package-manager caches without walking a developer's home tree.
 * Paths come from each tool's own configuration; Cargo's two global derived
 * roots are the documented children of CARGO_HOME.
 */
export async function collectPackageCaches(
  options: PackageCacheOptions = {},
): Promise<CacheObservation[]> {
  const env = options.env ?? process.env;
  const run = options.run ?? runBounded;
  const home = env["HOME"]?.replace(/\/$/, "");
  const cargoHome = env["CARGO_HOME"] ?? (home ? `${home}/.cargo` : null);
  let [npm, pnpm, pnpmCache, bun] = await Promise.all([
    configuredPath(run, ["npm", "config", "get", "cache"], home),
    configuredPath(run, ["pnpm", "store", "path"], home),
    configuredPath(run, ["pnpm", "cache", "path"], home),
    configuredPath(run, ["bun", "pm", "cache"]),
  ]);
  let npmArgv = ["npm", "cache", "verify"];
  if (!npm) {
    npm = await configuredPath(
      run,
      ["mise", "exec", "node@latest", "--", "npm", "config", "get", "cache"],
      home,
    );
    npmArgv = ["mise", "exec", "node@latest", "--", "npm", "cache", "verify"];
  }

  const definitions: Omit<CacheObservation, "bytes">[] = [];
  if (cargoHome) {
    definitions.push(
      {
        kind: "cargo-registry",
        path: `${cargoHome}/registry`,
        argv: null,
        note: "Cargo native GC: unused downloads 3 months; regenerable data 1 month",
      },
      {
        kind: "cargo-git",
        path: `${cargoHome}/git`,
        argv: null,
        note: "Cargo native GC: unused downloads 3 months; regenerable data 1 month",
      },
    );
  }
  if (npm) definitions.push({
    kind: "npm",
    path: npm,
    argv: npmArgv,
    cwd: home,
    note: "npm integrity verification and garbage collection",
  });
  if (pnpm) definitions.push({
    kind: "pnpm",
    path: pnpm,
    argv: ["pnpm", "store", "prune"],
    cwd: home,
    note: "unreferenced packages only",
  });
  if (pnpmCache) definitions.push({
    kind: "pnpm-cache",
    path: pnpmCache,
    argv: null,
    note: "metadata/dlx cache; pnpm bulk deletion is experimental, so inventory only",
  });
  if (bun) definitions.push({
    kind: "bun",
    path: bun,
    argv: ["bun", "pm", "cache", "rm"],
    cwd: process.cwd(),
    note: "entire regenerable Bun package cache",
  });

  const bytes = await Promise.all(definitions.map((item) => cacheUsageBytes(item.path, run)));
  return definitions.map((item, index) => ({ ...item, bytes: bytes[index] ?? null }));
}

/** Resolve exactly one Cargo workspace target; never scan all of HOME. */
export async function inspectCargoBuildCache(
  workspace = process.cwd(),
  run: CacheCommandRunner = runBounded,
): Promise<CacheObservation | null> {
  let cwd: string;
  try {
    cwd = realpathSync(resolve(workspace));
  } catch {
    return null;
  }
  const metadata = await safely(
    run,
    ["cargo", "metadata", "--no-deps", "--format-version", "1"],
    { cwd, timeoutMs: 30_000 },
  );
  if (!metadata || metadata.timedOut || metadata.exitCode !== 0) return null;
  let parsed: { workspace_root?: unknown; target_directory?: unknown };
  try {
    parsed = JSON.parse(metadata.stdout) as typeof parsed;
  } catch {
    return null;
  }
  if (typeof parsed.workspace_root !== "string" || typeof parsed.target_directory !== "string") {
    return null;
  }
  const workspaceRoot = absolutePath(parsed.workspace_root);
  const targetPath = absolutePath(parsed.target_directory);
  if (!workspaceRoot || !targetPath || targetPath === "/" || targetPath === workspaceRoot) return null;
  const marker = join(targetPath, "CACHEDIR.TAG");
  try {
    if (!readFileSync(marker, "utf8").includes("8a477f597d28d172789f06886806bc55")) return null;
  } catch {
    return null;
  }
  const bytes = await cacheUsageBytes(targetPath, run);
  return {
    kind: "cargo-target",
    path: targetPath,
    bytes,
    argv: [
      "cargo", "clean",
      "--manifest-path", join(workspaceRoot, "Cargo.toml"),
      "--target-dir", targetPath,
    ],
    cwd: workspaceRoot,
    note: `derived build output for ${workspaceRoot}`,
  };
}

/** Execute only the tool-native actions selected by an explicit Reclaim. */
export async function applyCacheMaintenance(
  observations: readonly CacheObservation[],
  run: CacheCommandRunner = runBounded,
): Promise<CacheMaintenanceOutcome[]> {
  const outcomes: CacheMaintenanceOutcome[] = [];
  for (const observation of observations) {
    if (!observation.argv) continue;
    const before = await cacheUsageBytes(observation.path, run);
    const result = await safely(run, observation.argv, {
      cwd: observation.cwd,
      timeoutMs: 10 * 60_000,
    });
    if (!result || result.timedOut || result.exitCode !== 0) {
      outcomes.push({
        kind: observation.kind,
        ok: false,
        freedBytes: null,
        detail: result?.timedOut
          ? "maintenance timed out"
          : (result?.stderr.trim() || "maintenance command failed to start"),
      });
      continue;
    }
    const after = await cacheUsageBytes(observation.path, run);
    outcomes.push({
      kind: observation.kind,
      ok: true,
      freedBytes: before === null || after === null ? null : Math.max(0, before - after),
      detail: result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? "completed",
    });
  }
  return outcomes;
}
