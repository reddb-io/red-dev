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

const emit = (line: string, sink: (s: string) => void): void => {
  if (buffer) buffer.push(line);
  else sink(line);
};

export const log = {
  step: (msg: string) => emit(`${paint("1;34", "::")} ${msg}`, console.log),
  ok: (msg: string) => emit(`${paint("1;32", " ok ")} ${msg}`, console.log),
  warn: (msg: string) => emit(`${paint("1;33", "warn")} ${msg}`, console.warn),
  err: (msg: string) => emit(`${paint("1;31", "fail")} ${msg}`, console.error),
  skip: (msg: string) => emit(`${paint("1;90", "skip")} ${msg}`, console.log),
  plain: (msg: string) => emit(msg, console.log),
};

export class RedError extends Error {}

export function die(msg: string): never {
  log.err(msg);
  process.exit(1);
}
