/**
 * Leave a trace when the process dies.
 *
 * A fullscreen app that crashes on Windows takes the console with it,
 * so the stack scrolls past inside a window that is already closing and
 * there is nothing left to report but "it crashed". Writing it to a file
 * first turns that into something diagnosable — and the file is the only
 * copy that survives the window.
 *
 * Deliberately synchronous: an async write loses the race with process
 * death, which is the one case this exists for. It is also deliberately
 * light — node:fs and the state directory, nothing else — because it is
 * imported by main.ts on every run rather than behind the dynamic import
 * every command body uses, and because the module that runs while the
 * process is dying is the wrong place to discover a broken import.
 *
 * What is done with the capture afterwards lives in crash-handoff.ts,
 * which is reached only once there is a crash to hand over.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { transcriptDir } from "./transcript.ts";

/** What was written down, so a caller can act on it without re-reading. */
export interface CrashCapture {
  /** Where every crash on this machine is appended. */
  path: string;
  /** This crash's entry, exactly as the file received it. */
  entry: string;
  /** `uncaughtException` or `unhandledRejection` — the header's first word. */
  kind: string;
}

/** Every side of the machine this touches, so a test can hold all of them. */
export interface CrashCaptureDeps {
  /** Where the log goes. Defaults to this machine's state directory. */
  dir?: string;
  at?: Date;
  version?: string;
  platform?: string;
  /** Writes the entry. Injected so a test never appends to a real log. */
  append?: (path: string, entry: string) => void;
  /**
   * The copy for a terminal that survived, which is not the same
   * medium as the file: it leaves the alternate screen first, because
   * a crash inside a fullscreen view otherwise prints behind a frame
   * nobody is drawing any more.
   */
  say?: (text: string) => void;
}

function defaultAppend(path: string, entry: string): void {
  mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
  appendFileSync(path, entry);
}

/**
 * Append one crash and hand back what was written.
 *
 * A failing write is swallowed on purpose: there is nothing useful to
 * do about it while the process is dying, and the console copy below is
 * the fallback. The capture is still returned, so what could not be
 * written to a file can still be handed to an agent.
 */
export function recordCrash(
  kind: string,
  err: unknown,
  deps: CrashCaptureDeps = {},
): CrashCapture {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const at = deps.at ?? new Date();
  const version = deps.version ?? "";
  const platform = deps.platform ?? process.platform;
  const path = `${deps.dir ?? transcriptDir()}/crash.log`;
  const entry = `\n=== ${at.toISOString()} ${kind} red-dev ${version} ${platform} ===\n${detail}\n`;

  try {
    (deps.append ?? defaultAppend)(path, entry);
  } catch {
    // Nothing useful to do if even this fails.
  }

  // stderr as well as the file: on a terminal that survives, the user
  // should not have to know a log file exists.
  const say = deps.say ?? ((text: string) => process.stderr.write(text));
  say(`\x1b[?1049l${entry}\nrecorded to ${path}\n`);

  return { path, entry, kind };
}
