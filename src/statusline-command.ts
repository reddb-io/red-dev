import type { Readable } from "node:stream";
import { runBounded } from "./bounded-command.ts";
import { latestDevBundle } from "./statusline-health.ts";

const MAX_PAYLOAD_BYTES = 1024 * 1024;
// Keep the deadline inside the portable command; leave startup/teardown margin.
const COMMAND_BUDGET_MS = 1_000;

/** Read one complete JSON value without waiting for the caller to close stdin. */
export async function readStatuslinePayload(
  input: Readable = process.stdin,
  timeoutMs = 500,
): Promise<string | null> {
  return await new Promise((resolve) => {
    let text = "";
    let done = false;
    const finish = (value: string | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      input.off("data", onData);
      input.off("end", onEnd);
      input.pause();
      resolve(value);
    };
    const complete = (): boolean => {
      try {
        JSON.parse(text);
        finish(text);
        return true;
      } catch {
        return false;
      }
    };
    const onData = (chunk: string | Buffer): void => {
      text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      if (Buffer.byteLength(text) > MAX_PAYLOAD_BYTES) finish(null);
      else complete();
    };
    const onEnd = (): void => {
      if (!complete()) finish(null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
  });
}

export async function renderStatusline(payload: string, timeoutMs: number): Promise<string> {
  // Bun exposes no Windows Job Object, so it cannot prove a spawned bundle's
  // descendants died. Keep the portable command childless on that platform.
  if (process.platform === "win32") return "red-dev";
  const bundle = latestDevBundle();
  const node = Bun.which("node");
  if (!bundle || !node) return "";
  const result = await runBounded([node, bundle, "statusline"], {
    stdin: payload,
    timeoutMs,
    killGraceMs: 250,
  });
  return result.groupGone ? result.stdout : "";
}

export async function statuslineCommand(): Promise<number> {
  const startedAt = performance.now();
  process.stdout.on("error", () => {
    // Claude may close the pipe between refreshes. EPIPE is a silent render miss.
  });
  const payload = await readStatuslinePayload(process.stdin, 250);
  if (payload === null) return 0;
  try {
    const remaining = Math.max(1, COMMAND_BUDGET_MS - (performance.now() - startedAt));
    process.stdout.write(await renderStatusline(payload, remaining));
  } catch {
    // Statusline failure is cosmetic and must never reach global crash logging.
  }
  return 0;
}
