export interface BoundedCommandOptions {
  timeoutMs?: number;
  killGraceMs?: number;
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: "ignore" | Uint8Array | string;
  /** Write the payload but keep the pipe open to probe EOF-sensitive consumers. */
  keepStdinOpen?: boolean;
}

export interface BoundedCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  groupGone: boolean;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function signalGroup(proc: Bun.Subprocess, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, signal);
    else proc.kill(signal);
  } catch {
    // ESRCH means the group already ended, which is the desired state.
  }
}

function groupExists(pid: number): boolean {
  try {
    if (process.platform !== "win32") process.kill(-pid, 0);
    else process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function capture(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  cancel: () => Promise<void>;
} {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let value = "";
  const text = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        value += decoder.decode(chunk.value, { stream: true });
      }
      value += decoder.decode();
    } catch {
      // Cancellation after the absolute deadline returns what was captured.
    }
    return value;
  })();
  return {
    text,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // The stream may already have closed.
      }
    },
  };
}

/** Run a host probe with a total deadline and process-group cleanup. */
export async function runBounded(
  argv: string[],
  options: BoundedCommandOptions = {},
): Promise<BoundedCommandResult> {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const killGraceMs = options.killGraceMs ?? 250;
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin === "ignore" || options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    detached: process.platform !== "win32",
  });
  if (options.stdin !== undefined && options.stdin !== "ignore" && proc.stdin) {
    proc.stdin.write(options.stdin);
    if (!options.keepStdinOpen) proc.stdin.end();
  }

  const stdout = capture(proc.stdout);
  const stderr = capture(proc.stderr);
  const completed = Promise.all([proc.exited, stdout.text, stderr.text]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([completed.then(() => "exit" as const), deadline]);
  if (timer) clearTimeout(timer);

  // A leader exiting is not completion when it leaves members in its group.
  // Treat that as a lifecycle timeout and clean the group immediately.
  const timedOut = outcome === "timeout" || groupExists(proc.pid);
  if (timedOut) {
    try {
      proc.stdin?.end();
    } catch {
      // The child may already have closed stdin.
    }
    signalGroup(proc, "SIGTERM");
    for (let elapsed = 0; elapsed < killGraceMs && groupExists(proc.pid); elapsed += 25) {
      await delay(Math.min(25, killGraceMs - elapsed));
    }
    if (groupExists(proc.pid)) signalGroup(proc, "SIGKILL");
    const settled = await Promise.race([
      completed.then(() => true),
      delay(killGraceMs).then(() => false),
    ]);
    if (!settled) await Promise.all([stdout.cancel(), stderr.cancel()]);
  }
  if (!timedOut) await completed;

  return {
    exitCode: proc.exitCode,
    stdout: await stdout.text,
    stderr: await stderr.text,
    timedOut,
    // A dead PID proves a POSIX process group is empty. On Windows it says
    // nothing about descendants, so never promote it to verified teardown.
    groupGone: process.platform !== "win32" && !groupExists(proc.pid),
  };
}
