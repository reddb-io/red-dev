const useColor = process.stdout.isTTY === true && !process.env["NO_COLOR"];

const paint = (code: string, s: string): string =>
  useColor ? `\x1b[${code}m${s}\x1b[0m` : s;

export const log = {
  step: (msg: string) => console.log(`${paint("1;34", "::")} ${msg}`),
  ok: (msg: string) => console.log(`${paint("1;32", " ok ")} ${msg}`),
  warn: (msg: string) => console.warn(`${paint("1;33", "warn")} ${msg}`),
  err: (msg: string) => console.error(`${paint("1;31", "fail")} ${msg}`),
  skip: (msg: string) => console.log(`${paint("1;90", "skip")} ${msg}`),
  plain: (msg: string) => console.log(msg),
};

export class RedError extends Error {}

export function die(msg: string): never {
  log.err(msg);
  process.exit(1);
}
