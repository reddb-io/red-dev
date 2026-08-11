import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import type { RetainedFile, RetentionSelection } from "./retention.ts";
import { selectRetention } from "./retention.ts";
import { runBounded } from "./bounded-command.ts";
import type { BoundedCommandOptions, BoundedCommandResult } from "./bounded-command.ts";
import { transcriptDir } from "./transcript.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const CRASH_DUMP_BUDGET = 2 * 1024 ** 3;
const TRANSCRIPT_POLICY = { maxCount: 20, maxAgeMs: 30 * DAY, maxBytes: 250 * 1024 ** 2 };
const ZELLIJ_POLICY = { maxCount: 10, maxAgeMs: 14 * DAY, maxBytes: 50 * 1024 ** 2 };
const RED_DEV_CRASH_POLICY = { maxCount: 1, maxAgeMs: 30 * DAY, maxBytes: 10 * 1024 ** 2 };

function dumpExecutable(name: string): string {
  return name.replace(/\.\d+\.dmp$/i, "").toLowerCase();
}

/** Conservative Windows dump policy: recent + newest three are evidence. */
export function selectCrashDumpRetention(
  files: RetainedFile[],
  nowMs = Date.now(),
): RetentionSelection[] {
  const protectedPaths = new Set<string>();
  const groups = new Map<string, RetainedFile[]>();
  for (const file of files) {
    const key = dumpExecutable(file.name);
    groups.set(key, [...(groups.get(key) ?? []), file]);
    if (nowMs - file.mtimeMs <= 72 * HOUR) protectedPaths.add(file.path);
  }
  for (const group of groups.values()) {
    for (const file of [...group].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 3)) {
      protectedPaths.add(file.path);
    }
  }

  const selected = new Map<string, RetentionSelection>();
  const choose = (file: RetainedFile, reason: string): void => {
    if (protectedPaths.has(file.path)) return;
    const existing = selected.get(file.path);
    if (existing) existing.reasons.push(reason);
    else selected.set(file.path, { file, reasons: [reason] });
  };
  const ordered = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of ordered) {
    if (bytes <= CRASH_DUMP_BUDGET) break;
    if (selected.has(file.path) || protectedPaths.has(file.path)) continue;
    choose(file, "over 2 GiB CrashDump budget");
    bytes -= file.size;
  }

  return [...selected.values()].sort((a, b) => a.file.mtimeMs - b.file.mtimeMs);
}

export type ReclaimKind = "transcript" | "zellij-crash" | "red-dev-crash" | "windows-dump";

export interface ReclaimItem extends RetentionSelection {
  kind: ReclaimKind;
  dev: number;
  ino: number;
}

export interface ReclaimPlan {
  items: ReclaimItem[];
  bytes: number;
}

export interface ReclaimPlanOptions {
  stateRoot: string;
  nowMs?: number;
  includeCrashDumps: boolean;
  crashDumpDir?: string | null;
  livePids?: ReadonlySet<number>;
  protectedPaths?: ReadonlySet<string>;
}

function filesIn(dir: string, accept: (name: string) => boolean): RetainedFile[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      if (!accept(name)) return [];
      const path = `${dir.replace(/\/$/, "")}/${name}`;
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink()) return [];
        return [{ path, name, size: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

function asItems(kind: ReclaimKind, selected: RetentionSelection[]): ReclaimItem[] {
  return selected.flatMap((selection) => {
    try {
      const stat = lstatSync(selection.file.path);
      return [{ ...selection, kind, dev: stat.dev, ino: stat.ino }];
    } catch {
      return [];
    }
  });
}

export interface ArtifactUsage {
  count: number;
  bytes: number;
}

export interface ArtifactUsageReport {
  transcripts: ArtifactUsage;
  zellijCrashes: ArtifactUsage;
  redDevCrashes: ArtifactUsage;
  windowsDumps: ArtifactUsage;
}

function usage(files: RetainedFile[]): ArtifactUsage {
  return { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

export function collectArtifactUsage(
  stateRoot: string,
  crashDumpDir: string | null = null,
): ArtifactUsageReport {
  return {
    transcripts: usage(filesIn(stateRoot, (name) => /^\d{4}-\d{2}-\d{2}T.*\.log$/.test(name))),
    zellijCrashes: usage(filesIn(`${stateRoot}/zellij`, (name) => /^crash-\d+\.log$/.test(name))),
    redDevCrashes: usage(filesIn(stateRoot, (name) => /^crash(?:\.previous)?\.log$/.test(name))),
    windowsDumps: usage(
      crashDumpDir ? filesIn(crashDumpDir, (name) => name.toLowerCase().endsWith(".dmp")) : [],
    ),
  };
}

export function collectReclaimPlan(options: ReclaimPlanOptions): ReclaimPlan {
  const nowMs = options.nowMs ?? Date.now();
  const protectedPaths = options.protectedPaths ?? new Set<string>();
  const transcripts = filesIn(options.stateRoot, (name) => /^\d{4}-\d{2}-\d{2}T.*\.log$/.test(name));
  const zellij = filesIn(`${options.stateRoot}/zellij`, (name) => /^crash-\d+\.log$/.test(name));
  const livePids = options.livePids ?? new Set<number>();
  const zellijProtected = new Set(protectedPaths);
  for (const file of zellij) {
    const pid = Number.parseInt(/^crash-(\d+)\.log$/.exec(file.name)?.[1] ?? "", 10);
    if (livePids.has(pid)) zellijProtected.add(file.path);
  }
  const redDevCrashes = filesIn(
    options.stateRoot,
    (name) => name === "crash.log" || name === "crash.previous.log",
  );

  const items = [
    ...asItems("transcript", selectRetention(transcripts, TRANSCRIPT_POLICY, nowMs, protectedPaths)),
    ...asItems("zellij-crash", selectRetention(zellij, ZELLIJ_POLICY, nowMs, zellijProtected)),
    ...asItems(
      "red-dev-crash",
      selectRetention(redDevCrashes, RED_DEV_CRASH_POLICY, nowMs, protectedPaths),
    ),
  ];
  if (options.includeCrashDumps && options.crashDumpDir) {
    const dumps = filesIn(options.crashDumpDir, (name) => name.toLowerCase().endsWith(".dmp"));
    items.push(...asItems("windows-dump", selectCrashDumpRetention(dumps, nowMs)));
  }

  items.sort((a, b) => a.file.mtimeMs - b.file.mtimeMs || a.file.path.localeCompare(b.file.path));
  return { items, bytes: items.reduce((sum, item) => sum + item.file.size, 0) };
}

export interface ReclaimResult {
  removed: string[];
  removedBytes: number;
  skipped: Array<{ path: string; reason: string }>;
  failed: Array<{ path: string; reason: string }>;
}

/** Apply exactly a previewed plan after inode/size/mtime revalidation. */
export function applyReclaim(plan: ReclaimPlan): ReclaimResult {
  const removed: string[] = [];
  const skipped: ReclaimResult["skipped"] = [];
  const failed: ReclaimResult["failed"] = [];
  let removedBytes = 0;

  for (const item of plan.items) {
    let current;
    try {
      current = lstatSync(item.file.path);
    } catch {
      skipped.push({ path: item.file.path, reason: "file disappeared after preview" });
      continue;
    }
    if (
      !current.isFile() ||
      current.isSymbolicLink() ||
      current.dev !== item.dev ||
      current.ino !== item.ino ||
      current.size !== item.file.size ||
      current.mtimeMs !== item.file.mtimeMs
    ) {
      skipped.push({ path: item.file.path, reason: "file changed after preview" });
      continue;
    }
    try {
      rmSync(item.file.path);
      if (existsSync(item.file.path)) throw new Error("path still exists");
      removed.push(item.file.path);
      removedBytes += item.file.size;
    } catch (error) {
      failed.push({
        path: item.file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removed, removedBytes, skipped, failed };
}

export function redDevStateRoot(
  env: Record<string, string | undefined> = process.env,
  _platform = process.platform,
): string {
  return transcriptDir(env);
}

/** Resolve %LOCALAPPDATA%/CrashDumps natively or through bounded WSL interop. */
export async function windowsCrashDumpDir(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
): Promise<string | null> {
  if (platform === "win32") {
    const local = env["LOCALAPPDATA"];
    return local ? `${local.replace(/\\/g, "/")}/CrashDumps` : null;
  }
  if (!env["WSL_DISTRO_NAME"] || !Bun.which("powershell.exe") || !Bun.which("wslpath")) return null;
  const local = await runBounded([
    "powershell.exe",
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[Environment]::GetFolderPath('LocalApplicationData')",
  ]);
  const windowsPath = local.stdout.trim();
  if (local.timedOut || local.exitCode !== 0 || windowsPath === "") return null;
  const converted = await runBounded(["wslpath", "-u", `${windowsPath}\\CrashDumps`]);
  const path = converted.stdout.trim();
  return !converted.timedOut && converted.exitCode === 0 && path !== "" ? path : null;
}

export async function windowsDiskUsage(
  run: (
    argv: string[],
    options?: BoundedCommandOptions,
  ) => Promise<BoundedCommandResult> = runBounded,
): Promise<{ freeBytes: number; totalBytes: number } | null> {
  const powershell = Bun.which("powershell.exe") ?? Bun.which("powershell");
  if (!powershell && run === runBounded) return null;
  const result = await run(
    [
      powershell ?? "powershell.exe",
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$d=Get-PSDrive -Name C; @{free=[int64]$d.Free;total=[int64]($d.Free+$d.Used)} | ConvertTo-Json -Compress",
    ],
    { timeoutMs: 2_000 },
  );
  if (result.timedOut || result.exitCode !== 0) return null;
  try {
    const value = JSON.parse(result.stdout) as { free?: unknown; total?: unknown };
    return typeof value.free === "number" && typeof value.total === "number" && value.total > 0
      ? { freeBytes: value.free, totalBytes: value.total }
      : null;
  } catch {
    return null;
  }
}

export interface WorkerGateState {
  known: boolean;
  workers: number;
}

/** Query every running WSL daemon from native Windows without starting a distro. */
export async function windowsWslWorkerState(
  _distro?: string,
  run: (
    argv: string[],
    options?: BoundedCommandOptions,
  ) => Promise<BoundedCommandResult> = runBounded,
): Promise<WorkerGateState> {
  const wsl = Bun.which("wsl.exe");
  if (!wsl && run === runBounded) return { known: false, workers: 0 };
  const running = await run([wsl ?? "wsl.exe", "--list", "--running", "--quiet"], {
    timeoutMs: 2_000,
  });
  if (running.timedOut || running.exitCode !== 0) return { known: false, workers: 0 };
  const distros = running.stdout
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((name) => name.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);
  // Querying inside a running distro can restart it if it stops between this
  // inventory and wsl.exe -d. Fail closed instead; a stopped host is known idle.
  return distros.length === 0
    ? { known: true, workers: 0 }
    : { known: false, workers: 0 };
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}
