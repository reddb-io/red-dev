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
import { startProcessHeartbeat } from "./process-heartbeat.ts";
import type { Platform } from "./platform.ts";
import { unattendedEnvironment } from "./unattended.ts";

/**
 * Runtimes installed on every machine.
 *
 * Deliberately short. Omakub asks which languages you want; red-dev
 * installs the one it needs to be self-hosting and leaves the rest to
 * `mise use`. A prompt that installs four runtimes nobody asked for is
 * how a dev environment becomes 8 GB.
 */
const DEFAULT_RUNTIMES = ["node@24"] as const;

/**
 * Offered by `red-dev lang`. omakub asks the same question at first
 * run; here it is a command you can re-run, because the answer changes
 * when a project does.
 */
export interface RuntimeVersionChoice {
  id: string;
  label: string;
}

export interface OfferedRuntime {
  /** Default selector used when the language is first checked. */
  id: string;
  label: string;
  about: string;
  versions: RuntimeVersionChoice[];
}

/**
 * Supported lines shown directly on the language picker.
 *
 * Every list ends in a moving channel so the UI remains useful between
 * red-dev releases, while the numbered entries let a project stay on a
 * major/minor line. Mise resolves each selector to the newest patch on it.
 */
export const OFFERED_RUNTIMES: OfferedRuntime[] = [
  {
    id: "node@24",
    label: "Node.js",
    about: "also brings npm and corepack",
    versions: [
      { id: "node@22", label: "22 LTS" },
      { id: "node@24", label: "24 LTS" },
      { id: "node@26", label: "26 Current" },
      { id: "node@latest", label: "Latest" },
    ],
  },
  {
    id: "bun@1.3",
    label: "Bun",
    about: "runtime, bundler and package manager",
    versions: [
      { id: "bun@1.2", label: "1.2" },
      { id: "bun@1.3", label: "1.3" },
      { id: "bun@latest", label: "Latest" },
    ],
  },
  {
    id: "deno@2.9",
    label: "Deno",
    about: "secure JavaScript and TypeScript runtime",
    versions: [
      { id: "deno@2.8", label: "2.8" },
      { id: "deno@2.9", label: "2.9" },
      { id: "deno@latest", label: "Latest" },
    ],
  },
  {
    id: "python@3.13",
    label: "Python",
    about: "CPython with SQLite support verified after install",
    versions: [
      { id: "python@3.13", label: "3.13" },
      { id: "python@3.14", label: "3.14" },
      { id: "python@latest", label: "Latest" },
    ],
  },
  {
    id: "go@1.26",
    label: "Go",
    about: "compiler and standard toolchain",
    versions: [
      { id: "go@1.25", label: "1.25" },
      { id: "go@1.26", label: "1.26" },
      { id: "go@latest", label: "Latest" },
    ],
  },
  {
    id: "rust@1.97",
    label: "Rust",
    about: "via rustup",
    versions: [
      { id: "rust@1.96", label: "1.96" },
      { id: "rust@1.97", label: "1.97" },
      { id: "rust@stable", label: "Stable" },
    ],
  },
  {
    id: "ruby@3.4",
    label: "Ruby",
    about: "MRI Ruby",
    versions: [
      { id: "ruby@3.3", label: "3.3" },
      { id: "ruby@3.4", label: "3.4" },
      { id: "ruby@4.0", label: "4.0" },
      { id: "ruby@latest", label: "Latest" },
    ],
  },
  {
    id: "java@25",
    label: "Java",
    about: "OpenJDK",
    versions: [
      { id: "java@21", label: "21 LTS" },
      { id: "java@25", label: "25 LTS" },
      { id: "java@26", label: "26 Current" },
      { id: "java@latest", label: "Latest" },
    ],
  },
];

export type RuntimeVersionPolicy = "recommended" | "latest";

const RUNTIME_NAMES = new Set(
  OFFERED_RUNTIMES.map((runtime) => runtime.id.split("@")[0]!),
);

function runtimeName(id: string): string {
  return id.split("@")[0] ?? id;
}

/** The catalog entry for any selector belonging to a known runtime. */
export function offeredRuntime(id: string): OfferedRuntime | undefined {
  const name = runtimeName(id);
  return OFFERED_RUNTIMES.find((runtime) => runtimeName(runtime.id) === name);
}

/** The currently selected id for this language, or its displayed default. */
export function selectedRuntimeId(ids: string[], defaultId: string): string {
  const name = runtimeName(defaultId);
  return ids.find((id) => runtimeName(id) === name) ?? defaultId;
}

/** Human label for the selector currently shown on a language row. */
export function runtimeVersionLabel(id: string): string {
  const runtime = offeredRuntime(id);
  return runtime?.versions.find((version) => version.id === id)?.label ?? id.split("@")[1] ?? id;
}

/** Check or uncheck one language without creating two versions of it. */
export function toggleRuntimeSelection(ids: string[], defaultId: string): string[] {
  const name = runtimeName(defaultId);
  const found = ids.findIndex((id) => runtimeName(id) === name);
  if (found >= 0) return ids.filter((_, index) => index !== found);
  return [...ids, defaultId];
}

/** Cycle one language's selector in place, preserving every other choice. */
export function shiftRuntimeVersion(ids: string[], defaultId: string, delta: -1 | 1): string[] {
  const runtime = offeredRuntime(defaultId);
  if (!runtime || runtime.versions.length === 0) return [...ids];
  const name = runtimeName(defaultId);
  const selectedIndex = ids.findIndex((id) => runtimeName(id) === name);
  // Version arrows change a checked language; they do not also opt an
  // unchecked language in. Space owns that decision.
  if (selectedIndex < 0) return [...ids];
  const current = ids[selectedIndex]!;
  const currentIndex = Math.max(0, runtime.versions.findIndex((version) => version.id === current));
  const nextIndex = (currentIndex + delta + runtime.versions.length) % runtime.versions.length;
  const next = runtime.versions[nextIndex]!.id;
  return ids.map((id, index) => (index === selectedIndex ? next : id));
}

/** Apply the setup's version policy without changing which runtimes were chosen. */
export function runtimeIdsForPolicy(
  ids: string[],
  policy: RuntimeVersionPolicy,
): string[] {
  if (policy === "recommended") return [...ids];
  return ids.map((id) => `${id.split("@")[0]}@latest`);
}

/**
 * Runtime ids accepted at the CLI and safe to mirror through a WSL shell.
 *
 * The runtime name stays inside our catalog, while the mise selector may be
 * a channel (`latest`, `lts`, `stable`) or an exact version. Keeping the
 * selector deliberately boring also means a preference can be interpolated
 * into `red-dev lang ...` without becoming shell syntax.
 */
export function isKnownRuntimeId(id: string): boolean {
  const match = /^([a-z0-9-]+)@([A-Za-z0-9][A-Za-z0-9._+-]*)$/.exec(id);
  return match !== null && RUNTIME_NAMES.has(match[1]!);
}

/** Normalize an explicit CLI selection, returning bad values without running mise. */
export function resolveRuntimeIds(
  ids: string[],
  policy: RuntimeVersionPolicy,
): { ids: string[]; unknown: string[] } {
  const resolved = runtimeIdsForPolicy(ids, policy);
  return {
    ids: resolved,
    unknown: resolved.filter((id) => !isKnownRuntimeId(id)),
  };
}

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
  if (id.startsWith("python@")) {
    return { id, env: { MISE_PYTHON_COMPILE: "0" } };
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
    env: unattendedEnvironment(process.env, extraEnv),
  });
  const heartbeat = live ? startProcessHeartbeat(cmd) : null;
  try {
    const [out, err, code] = await Promise.all([
      readRuntimeOutput(proc.stdout, live, heartbeat?.activity),
      readRuntimeOutput(proc.stderr, live, heartbeat?.activity),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    heartbeat?.stop();
  }
}

/** Forward mise progress without surrendering the error text needed by callers. */
async function readRuntimeOutput(
  stream: ReadableStream<Uint8Array>,
  live: boolean,
  activity: (() => void) | undefined = undefined,
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
    activity?.();
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
