/**
 * Every mutating run, written down, so a converge can be read after it ends.
 *
 * The screen is the wrong medium for this and always was. A converge is
 * forty steps of scrollback inside a fullscreen frame; the interesting
 * three lines are a failure that happened ninety seconds ago and has
 * since scrolled past, and the only way to answer "why did that fail"
 * was to run the whole thing again and watch harder.
 *
 * ## A tee, not a sink
 *
 * log.ts already has two ways to redirect output — `buffer`, which holds
 * lines so they land under their own step, and `stream`, which the
 * fullscreen views use to turn log output into content they can draw.
 * A third *sink* would have to compete with those. So this is not a
 * sink: `transcribeTo` tees off `emit` before the routing decision, and
 * every line reaches the file whether it also reached the console, a
 * buffer, or a frame. Nothing downstream changes behaviour because a
 * transcript is open, and `logIsCaptured()` deliberately does not count
 * it — a child process must not start piping just because a file is
 * being written.
 *
 * ## What is in it, and what is not
 *
 * Every `log` call in a transcribed run. Child process output whenever something is
 * capturing — which is exactly the fullscreen case this exists for,
 * since `spawnLogged` pipes into the log there.
 *
 * NOT child output on a plain `red-dev install` at a terminal. There
 * `spawnLogged` inherits the console on purpose, so apt keeps its
 * progress bar and sudo can still ask for a password, and those bytes
 * never pass through `emit`. Teeing them would mean piping them, which
 * would take the interactivity away to improve a log file. The trade is
 * recorded here rather than hidden: run the fullscreen converge if you
 * want the child output too.
 *
 * ## Where
 *
 * State, not config, so deliberately NOT the shared root. A log is about
 * one machine on one afternoon; shared-root.ts's whole doctrine is that
 * configuration is shared and everything else is local. Two machines
 * writing transcripts into one directory would interleave two unrelated
 * stories.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { appendDiagnostic, LOG_FILE_COUNT, redactDiagnostic } from "./rotating-log.ts";

/** How many runs to keep. Past this the oldest go. */
const KEEP = 20;
const TRANSCRIPT_BUDGET = 50 * 1024 * 1024;
const RUN_FILE = /^\d{4}-\d{2}-\d{2}T[\w-]+\.log$/;

/** SGR sequences, which are for a terminal and not for a file. */
const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Where transcripts live on this machine.
 *
 * XDG_STATE_HOME is the right variable and the one nobody uses: state is
 * "data that should persist between restarts but is not important enough
 * for XDG_DATA_HOME", which is a log exactly. On Windows there is no XDG
 * anything, and LOCALAPPDATA is where a per-machine, non-roaming thing
 * belongs — the same directory the wallpapers already use.
 */
export function transcriptDir(env?: Record<string, string | undefined>): string {
  const e = env ?? process.env;
  const local = e["LOCALAPPDATA"];
  // This directory also owns migration ledgers and observation caches. Preserve
  // the established HOME/LOCALAPPDATA split rather than silently migrating state
  // as a side effect of adding log rotation (including existing Git Bash users).
  if (local && win32.isAbsolute(local) && !e["HOME"]) return `${local.replace(/\\/g, "/")}/red-dev/logs`;
  const state = e["XDG_STATE_HOME"];
  if (state && posix.isAbsolute(state)) return `${state}/red-dev`;
  const home = e["HOME"] ?? e["USERPROFILE"] ?? homedir();
  return `${home.replace(/\\/g, "/")}/.local/state/red-dev`;
}

/**
 * A filename that sorts chronologically and survives every filesystem.
 *
 * Colons are illegal on NTFS, which rules out an ISO timestamp as-is —
 * and the failure would be silent on Windows and invisible on Linux,
 * which is the worst way to find out.
 */
export function transcriptName(at: Date, command: string): string {
  const stamp = at.toISOString().replace(/[:.]/g, "-").replace(/Z$/, "");
  const safe = redactDiagnostic(command).replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 120) || "run";
  return `${stamp}-${safe}.log`;
}

/**
 * Keep the newest KEEP files, delete the rest.
 *
 * By name rather than by mtime, because the names sort chronologically
 * by construction and mtime on a /mnt/c path is not something to build
 * on. Returns what it removed so the caller can say so if it wants to.
 */
export function prunable(names: string[], keep = KEEP): string[] {
  const logs = names.filter((n) => n.endsWith(".log")).sort();
  return logs.slice(0, Math.max(0, logs.length - keep));
}

let handle: { path: string; write: (line: string) => void } | null = null;
let releaseTee: (() => void) | null = null;

/** Retain completed/dead-process runs only; never delete a live writer's files. */
export function pruneTranscripts(dir: string, opts: { keep?: number; maxBytes?: number; protectedPaths?: Set<string> } = {}): string[] {
  const families: { path: string; files: string[]; bytes: number; eligible: boolean }[] = [];
  for (const name of readdirSync(dir).filter(name => RUN_FILE.test(name)).sort().reverse()) {
    const path = `${dir}/${name}`;
    const candidates = [path, ...Array.from({ length: LOG_FILE_COUNT - 1 }, (_, i) => `${path}.${i + 1}`)];
    let bytes = 0;
    const files: string[] = [];
    for (const candidate of candidates) {
      try {
        const stat = lstatSync(candidate);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        bytes += stat.size;
        files.push(candidate);
      } catch { /* a writer may have rotated between observations */ }
    }
    if (!files.includes(path)) continue;
    let complete = false;
    try {
      const size = lstatSync(path).size;
      const fd = openSync(path, "r");
      try {
        const tail = Buffer.alloc(Math.min(80, size));
        readSync(fd, tail, 0, tail.length, Math.max(0, size - tail.length));
        complete = /# exit \d+\s*$/.test(tail.toString());
      } finally { closeSync(fd); }
    } catch { continue; }
    const pid = Number(/-p(\d+)\.log$/.exec(name)?.[1]);
    let dead = false;
    if (pid > 0) {
      try { process.kill(pid, 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    families.push({ path, files, bytes, eligible: !opts.protectedPaths?.has(path) && (pid > 0 ? dead : complete) });
  }
  let retainedBytes = 0;
  let retainedRuns = 0;
  const removed: string[] = [];
  for (const family of families) {
    const excess = retainedRuns >= (opts.keep ?? KEEP) || retainedBytes + family.bytes > (opts.maxBytes ?? TRANSCRIPT_BUDGET);
    // Keep at least the newest run, and never delete live/unknown evidence.
    if (excess && retainedRuns > 0 && family.eligible) {
      for (const path of family.files) {
        try {
          const stat = lstatSync(path);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          unlinkSync(path);
          removed.push(path);
        } catch { /* retention is best effort; a race never breaks a run */ }
      }
    } else { retainedRuns++; retainedBytes += family.bytes; }
  }
  return removed;
}

/** The transcript being written, if one is open. */
export function transcriptPath(): string | null {
  return handle?.path ?? null;
}

/**
 * Open a transcript for this run and tee every log line into it.
 *
 * Failure here is nonfatal but reported on stderr. A read-only home, a full
 * disk or a path that does not resolve must not stop a converge — the
 * transcript is a convenience, and a tool that refused to install
 * because it could not write its own log would be absurd.
 */
export async function startTranscript(command: string, version: string, at: Date): Promise<void> {
  try {
    const dir = transcriptDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });

    const path = `${dir}/${transcriptName(at, command).replace(/\.log$/, `-p${process.pid}.log`)}`;
    // The trigger, on the platform line, because two runs of the same
    // command in the same version can be entirely different runs. On the
    // machine that found this, `red-skills watch due` fired from a shell
    // prompt and from a systemd timer — one saw six coding agents and
    // the other saw none — and 119 transcripts recorded no way to tell
    // which was which. See src/trigger.ts.
    const { triggerOf } = await import("./trigger.ts");
    const trigger = triggerOf(process.env, process.stdout.isTTY === true);
    const header = [
      `# red-dev ${version} — ${command}`,
      `# ${at.toISOString()}`,
      `# ${process.platform} ${process.arch} — ${trigger}`,
      "",
    ].join("\n");
    appendDiagnostic(path, header);
    try { pruneTranscripts(dir, { protectedPaths: new Set([path]) }); } catch { /* retention must not disable logging */ }

    handle = {
      path,
      // Synchronous on purpose. A converge can exit — or be killed —
      // between a failure and the next tick, and an async write is
      // exactly the line that would be missing from the log of the run
      // that needed one.
      write: (line: string) => {
        try {
          appendDiagnostic(path, `${line.replace(ANSI, "")}\n`);
        } catch (error) {
          // A disk that filled mid-run stops the transcript, not the run.
          handle = null;
          process.stderr.write(`red-dev: diagnostic log unavailable at ${path}: ${String(error)}\n`);
        }
      },
    };

    const { transcribeTo } = await import("./log.ts");
    releaseTee?.();
    releaseTee = transcribeTo((line) => handle?.write(line));
  } catch (error) {
    handle = null;
    process.stderr.write(`red-dev: could not start diagnostic transcript: ${String(error)}\n`);
  }
}

/** Close the run, and say where it went. */
export function finishTranscript(exitCode: number): string | null {
  if (!handle) { releaseTee?.(); releaseTee = null; return null; }
  const active = handle;
  active.write("");
  active.write(`# exit ${exitCode}`);
  const persisted = handle !== null;
  handle = null;
  releaseTee?.();
  releaseTee = null;
  try { pruneTranscripts(transcriptDir(), { protectedPaths: new Set([active.path]) }); } catch { /* nonfatal */ }
  return persisted ? active.path : null;
}

/** The transcripts on this machine, newest first. */
export function recentTranscripts(): string[] {
  const dir = transcriptDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => RUN_FILE.test(n))
    .sort()
    .reverse()
    .map((n) => `${dir}/${n}`);
}

/**
 * A converge step, written straight to the file.
 *
 * Not through `log`, deliberately, and this is the one place that
 * bypass is correct. The fullscreen view draws these rows from its own
 * model, so they have never been log lines — teeing off `log` produced a
 * transcript with every provider's chatter and none of the outcomes it
 * belonged to, which is precisely backwards for reading a failure.
 *
 * Formatted as a fixed-width row so the file can be scanned by eye and
 * grepped by outcome: `grep failed` on a transcript should be the whole
 * technique.
 */
export function transcribeStep(r: {
  index: number;
  total: number;
  tool: string;
  provider: string;
  outcome: string;
  ms: number;
  detail?: string;
}): void {
  if (!handle) return;
  const row =
    `[${String(r.index).padStart(2)}/${r.total}] ` +
    `${r.tool.padEnd(22)} ${r.provider.padEnd(28)} ` +
    `${r.outcome.padEnd(9)} ${r.ms}ms`;
  handle.write(r.detail ? `${row}\n          ${r.detail}` : row);
}
