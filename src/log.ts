const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];

const paint = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

/**
 * When a reporter owns the current line, provider messages have to be
 * held rather than printed: writing mid-line turns a progress row into
 * a mangled one. Buffered here and emitted, indented, after the row is
 * closed.
 */
let buffer: string[] | null = null;

export function captureStart(): void {
  buffer = [];
}

export function captureStop(): string[] {
  const held = buffer ?? [];
  buffer = null;
  return held;
}

/**
 * A live sink, for when the interface is the terminal.
 *
 * Different from `buffer` on purpose. Buffering holds lines and hands
 * them over at the end, which is right for provider chatter that must
 * land under its own step. This one forwards each line as it happens,
 * because inside the fullscreen interface a command's output is the
 * thing being watched — and writing it to the console directly would
 * paint over the frame the renderer owns.
 */
let stream: ((line: string) => void) | null = null;

/** Redirect log output to `sink` until the returned function is called. */
export function captureTo(sink: (line: string) => void): () => void {
  const previous = stream;
  stream = sink;
  return () => {
    stream = previous;
  };
}

/**
 * Whether anything other than the console is receiving log output.
 *
 * Asked by whoever spawns a child process. `log` calls are routed, but a
 * child that inherits stdout writes to the terminal directly, and inside
 * the fullscreen interface that means writing over a frame the renderer
 * believes it owns — a line of apt output landing wherever the cursor
 * happened to be, in the middle of the right-hand column.
 */
export function logIsCaptured(): boolean {
  return buffer !== null || stream !== null;
}

/**
 * A tee, deliberately not a third sink.
 *
 * `buffer` and `stream` compete: each one takes routing away from the
 * console and from each other. A transcript must not compete with
 * either, because the runs worth reading afterwards are exactly the ones
 * where a fullscreen view has already claimed `stream`. So this runs
 * before the routing decision and changes nothing about it.
 *
 * logIsCaptured() deliberately does not count it. That function answers
 * "would a child process writing to the console damage a frame", and the
 * answer must not become yes merely because a file is open — a child
 * that started piping for that reason would lose its progress bar and
 * its ability to prompt.
 */
let transcript: ((line: string) => void) | null = null;

/** Tee every log line into `sink` until the returned function is called. */
export function transcribeTo(sink: (line: string) => void): () => void {
  const previous = transcript;
  transcript = sink;
  return () => {
    transcript = previous;
  };
}

const emit = (line: string, sink: (s: string) => void): void => {
  // First, and outside the routing: a line that fails to reach the
  // console must still reach the log, and the reverse.
  if (transcript) {
    try {
      transcript(line);
    } catch {
      // Never let writing the log break the thing being logged.
    }
  }
  if (buffer) buffer.push(line);
  else if (stream) stream(line);
  else sink(line);
};

export const log = {
  step: (msg: string) => emit(`${paint("1;34", "::")} ${msg}`, console.log),
  ok: (msg: string) => emit(`${paint("1;32", " ok ")} ${msg}`, console.log),
  warn: (msg: string) => emit(`${paint("1;33", "warn")} ${msg}`, console.warn),
  err: (msg: string) => emit(`${paint("1;31", "fail")} ${msg}`, console.error),
  skip: (msg: string) => emit(`${paint("1;90", "skip")} ${msg}`, console.log),
  /**
   * Narration: what is about to happen, what was downloaded, which hash
   * it had, what the installed binary answered.
   *
   * A level of its own rather than more `step` calls, because `step`
   * announces work and these announce facts about work already
   * announced. Same four-column prefix as the rest so the marks stay a
   * column the eye can scan.
   */
  info: (msg: string) => emit(`${paint("1;36", "info")} ${msg}`, console.log),
  plain: (msg: string) => emit(msg, console.log),
};

/**
 * A duration a person reads rather than a number. PURE.
 *
 * Here rather than in report.ts because narration and the summary have
 * to agree: an item whose row says 3.4s and whose narration says 3400ms
 * reads as two different measurements of two different things.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m ${s}s`;
}

/** Bytes, at the precision a download report needs. PURE. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export class RedError extends Error {}

export function die(msg: string): never {
  log.err(msg);
  process.exit(1);
}
