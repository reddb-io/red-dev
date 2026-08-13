/**
 * Language runtimes, owned by mise on every target.
 *
 * The problem this exists to prevent, in its usual form: `pnpm` resolves
 * in PowerShell and not in Git Bash on the same machine, so a script
 * that worked yesterday fails today with "command not found" and the
 * next hour goes into PATH archaeology.
 *
 * That is not bad luck with PATH. It is what happens when nothing owns
 * the toolchain: an installer put node somewhere, a shell picked it up,
 * another shell did not, and no single source decides which node is
 * "the" node.
 *
 * mise is that owner. It is already in the manifest for every target;
 * this is what makes it do something. Because config/bash/init.sh runs
 * `mise activate bash`, the same versions then resolve in WSL, on the
 * Linux desktop, and in Git Bash on Windows — which is the whole claim
 * of this project applied to the toolchain rather than the terminal.
 */

import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

/**
 * Runtimes installed on every machine.
 *
 * Deliberately short. Omakub asks which languages you want; red-dev
 * installs the one it needs to be self-hosting and leaves the rest to
 * `mise use`. A prompt that installs four runtimes nobody asked for is
 * how a dev environment becomes 8 GB.
 */
const DEFAULT_RUNTIMES = ["node@lts"] as const;

/**
 * Offered by `red-dev lang`. omakub asks the same question at first
 * run; here it is a command you can re-run, because the answer changes
 * when a project does.
 */
export const OFFERED_RUNTIMES: { id: string; about: string }[] = [
  { id: "node@lts", about: "Node.js LTS — also brings npm and corepack" },
  { id: "bun@latest", about: "Bun — runtime, bundler and package manager" },
  { id: "deno@latest", about: "Deno" },
  { id: "python@3.13", about: "Python 3.13" },
  { id: "go@latest", about: "Go" },
  { id: "rust@stable", about: "Rust, via rustup" },
  { id: "ruby@3.4", about: "Ruby 3.4" },
  { id: "java@lts", about: "Java LTS" },
];

/** Common runtimes start checked; the heavier project-specific three are opt-in. */
export function runtimeSelectedByDefault(id: string): boolean {
  const name = id.split("@")[0];
  return name !== "go" && name !== "ruby" && name !== "java";
}

export interface RuntimeObserver {
  stepStart?: (id: string) => void;
  stepEnd?: (id: string, error: string | null) => void;
}

export interface RuntimeInstallRequest {
  id: string;
  env: Record<string, string>;
}

/** Stable installation request behind a user-facing runtime channel. */
export function runtimeInstallRequest(id: string): RuntimeInstallRequest {
  if (id === "python@3.13") {
    return {
      // 3.13.15 briefly had no python-build-standalone artifact. Mise
      // fell back to compiling without libsqlite3-dev and produced a
      // Python that started successfully but could not import sqlite3.
      id: "python@3.13.14",
      env: { MISE_PYTHON_COMPILE: "0" },
    };
  }
  return { id, env: {} };
}

/** Install a specific set of runtimes, as chosen interactively. */
export async function useRuntimes(ids: string[], observer: RuntimeObserver = {}): Promise<void> {
  const mise = await miseBin();
  if (!mise) {
    const detail = "mise is not on PATH — run `red-dev install core` first";
    for (const id of ids) {
      observer.stepStart?.(id);
      observer.stepEnd?.(id, detail);
    }
    throw new RedError(detail);
  }

  for (const id of ids) {
    observer.stepStart?.(id);
    log.step(`mise: ${id}`);
    const request = runtimeInstallRequest(id);
    const result = await run(
      [mise, "use", "-g", "--yes", request.id],
      request.env,
      true,
    );
    const { code } = result;
    if (code !== 0) {
      const detail = failureDetail(result, code);
      log.err(`${id}: ${detail}`);
      observer.stepEnd?.(id, detail);
      continue;
    }

    if (id.startsWith("python@")) {
      const probe = await run(
        [mise, "exec", request.id, "--", "python", "-c", "import sqlite3"],
        request.env,
      );
      if (probe.code !== 0) {
        const detail = "Python installed without SQLite support";
        log.err(`${id}: ${detail}`);
        observer.stepEnd?.(id, detail);
        continue;
      }
    }

    log.ok(id);
    observer.stepEnd?.(id, null);
  }
}

/** What mise already manages, for pre-ticking a selection list. */
export async function currentRuntimes(): Promise<string[]> {
  const mise = await miseBin();
  if (!mise) return [];
  const { out } = await run([mise, "ls", "--installed"]);
  return out
    .split("\n")
    .map((l) => l.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

async function miseBin(): Promise<string | null> {
  return Bun.which("mise");
}

async function run(
  cmd: string[],
  extraEnv: Record<string, string> = {},
  live = false,
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...extraEnv },
  });
  const [out, err, code] = await Promise.all([
    readRuntimeOutput(proc.stdout, live),
    readRuntimeOutput(proc.stderr, live),
    proc.exited,
  ]);
  return { code, out, err };
}

/** Forward mise progress without surrendering the error text needed by callers. */
async function readRuntimeOutput(
  stream: ReadableStream<Uint8Array>,
  live: boolean,
): Promise<string> {
  const decoder = new TextDecoder();
  let raw = "";
  let rest = "";
  const emit = (line: string): void => {
    if (!live) return;
    const current = line.includes("\r") ? line.slice(line.lastIndexOf("\r") + 1) : line;
    if (current.trim()) log.plain(current.trimEnd());
  };

  for await (const chunk of stream) {
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    raw += text;
    rest += text;
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) emit(line);
    if (rest.includes("\r")) {
      const redraws = rest.split("\r");
      rest = redraws.pop() ?? "";
      emit(redraws.at(-1) ?? "");
    }
  }
  const final = decoder.decode();
  raw += final;
  rest += final;
  emit(rest);
  return raw;
}

function failureDetail(
  result: { out: string; err: string },
  code: number,
): string {
  const output = result.err.trim() || result.out.trim();
  const last = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  return last || `mise exited ${code}`;
}

export async function installRuntimes(p: Platform): Promise<void> {
  const mise = await miseBin();
  if (!mise) {
    // Not fatal: mise is installed by the same converge run, and on a
    // first pass it may land after this step in PATH terms.
    log.skip("mise not on PATH yet — re-run install to set up runtimes");
    return;
  }

  const { out: installed } = await run([mise, "ls", "--installed"]);

  for (const runtime of DEFAULT_RUNTIMES) {
    const name = runtime.split("@")[0]!;
    if (installed.includes(name)) {
      log.skip(`${runtime} already managed by mise`);
      continue;
    }
    log.step(`mise: ${runtime}`);
    const result = await run(
      [mise, "use", "-g", "--yes", runtime],
      {},
      true,
    );
    const { code } = result;
    if (code !== 0) {
      throw new RedError(`mise use -g ${runtime} failed: ${failureDetail(result, code)}`);
    }
  }

  // corepack ships with node and is what makes `pnpm` and `yarn`
  // resolve without a second global install — the exact command that
  // was missing from one shell and present in another.
  const { out: nodePath } = await run([mise, "which", "node"]);
  if (nodePath.trim()) {
    const corepack = Bun.which("corepack");
    if (corepack) {
      const { code } = await run([corepack, "enable"]);
      if (code === 0) log.ok("corepack enabled (pnpm, yarn)");
      else log.skip("corepack enable needs elevated rights here — skipped");
    }
  }

  log.ok(`runtimes managed by mise (${p.env})`);
}

/**
 * Does the toolchain resolve the same way everywhere on this machine?
 *
 * On Windows that means asking Git Bash, not just the shell we happen
 * to be in: a tool present in one and absent in the other is the whole
 * failure mode, and it is invisible from either side alone.
 */
export async function toolchainParity(p: Platform): Promise<string | null> {
  if (p.os !== "windows") return null;

  const gitBash = ["C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe"].find(
    (c) => Bun.which(c) ?? false,
  );
  if (!gitBash) return null;

  const probe = "for t in node npm pnpm mise; do command -v $t >/dev/null 2>&1 || echo $t; done";
  const { out } = await run([gitBash, "-lc", probe]);
  const missing = out.trim().split("\n").filter(Boolean);

  return missing.length > 0
    ? `Git Bash cannot see: ${missing.join(", ")}`
    : null;
}

/**
 * Resolve a tool the runtimes own, even when this process cannot.
 *
 * The bug this closes: `mise use -g node@lts` succeeds, and four lines
 * later `Bun.which("npm")` still returns null — because PATH was read
 * when this process started, and installing node does not reach back in
 * time to change it. So the converge installed the runtime and then
 * refused to use it, telling the user to install what it had just
 * installed:
 *
 *   fail Gemini CLI: npm not on PATH — install a Node runtime first
 *   ...
 *   ok  node@lts
 *
 * `mise which npm` answers from mise's own state rather than from this
 * process's environment, which is the difference between "was it ever
 * installed" and "did my PATH happen to see it". It must win even when
 * PATH contains an executable: that entry can be a stale global shim
 * whose package directory has already disappeared.
 */
export function preferManagedTool(
  managed: { code: number; out: string } | null,
  direct: string | null,
): string | null {
  const path = managed?.out.trim().split("\n")[0]?.trim() ?? "";
  return managed?.code === 0 && path.length > 0 ? path : direct;
}

export async function runtimeTool(name: string): Promise<string | null> {
  const direct = Bun.which(name);
  const mise = await miseBin();
  if (!mise) return direct;
  return preferManagedTool(await run([mise, "which", name]), direct);
}
