/**
 * Liveness narration for child processes that may legitimately be silent.
 *
 * A child that emits progress is already observable through the shared
 * logger. A child that compiles, waits on a package-manager lock, or downloads
 * through a quiet vendor script otherwise looks exactly like a dead process.
 */

import { formatDuration, log } from "./log.ts";

export const PROCESS_HEARTBEAT_MS = 5_000;

function executableName(command: string[]): string {
  const executable = (command[0] ?? "command").replaceAll("\\", "/");
  return executable.split("/").at(-1) || "command";
}

export interface ProcessHeartbeat {
  /** Record bytes arriving even when they only redraw an unfinished line. */
  activity: () => void;
  /** Stop the timer. Always call this after the process settles. */
  stop: () => void;
}

/** Narrate elapsed and silent time until the caller says the child settled. */
export function startProcessHeartbeat(
  command: string[],
  intervalMs = PROCESS_HEARTBEAT_MS,
  tracksOutput = true,
  inactivityLabel = "no output for",
): ProcessHeartbeat {
  const started = Date.now();
  let lastActivity = started;
  const name = executableName(command);
  const timer = setInterval(() => {
    const now = Date.now();
    const silence = tracksOutput
      ? ` · ${inactivityLabel} ${formatDuration(now - lastActivity)}`
      : "";
    log.info(`${name} still running — ${formatDuration(now - started)} elapsed${silence}`);
  }, intervalMs);
  timer.unref?.();

  return {
    activity: () => {
      lastActivity = Date.now();
    },
    stop: () => clearInterval(timer),
  };
}
