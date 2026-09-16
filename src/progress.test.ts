/**
 * What an install says while something long is happening.
 *
 * The line report used to hold every line of a step until the step
 * closed, so an 84 MB download on a filtered corporate link sat behind
 * a bare row for minutes — indistinguishable from a hang, which on that
 * machine it sometimes also was. Progress now bypasses the hold, and the
 * heartbeat that carries it says how many bytes, of how many, how fast.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { captureTo, log, progressTo } from "./log.ts";
import { startProcessHeartbeat } from "./process-heartbeat.ts";
import { transferProgress } from "./providers.ts";
import { Reporter } from "./report.ts";

describe("transferProgress", () => {
  test("received, of how much, how fast", () => {
    expect(transferProgress(12 * 1024 * 1024, 84 * 1024 * 1024, 6_000)).toBe(
      "12.0 MB of 84.0 MB (14%) at 2.0 MB/s",
    );
  });

  test("without a Content-Length it still says what arrived", () => {
    expect(transferProgress(3 * 1024, null, 1_000)).toBe("3.0 KB received at 3.0 KB/s");
  });

  test("a server that under-declares its length is not reported past 100%", () => {
    expect(transferProgress(2048, 1024, 1_000)).toBe("2.0 KB received at 2.0 KB/s");
  });
});

describe("the heartbeat", () => {
  test("carries the transfer's numbers when the caller has them, and the silence when it does not", async () => {
    const seen: string[] = [];
    const release = captureTo((line) => seen.push(line));
    let sofar: string | null = null;
    const beat = startProcessHeartbeat(["fetch"], 20, true, "no response data for", () => sofar);
    try {
      await Bun.sleep(35);
      sofar = "1.0 MB of 2.0 MB (50%) at 1.0 MB/s";
      await Bun.sleep(35);
    } finally {
      beat.stop();
      release();
    }
    expect(seen.some((line) => line.includes("no response data for"))).toBe(true);
    expect(seen.some((line) => line.includes("1.0 MB of 2.0 MB (50%)"))).toBe(true);
  });
});

describe("the line report", () => {
  const original = process.stdout.write;
  let out = "";
  const capture = () => {
    out = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      out += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
  };
  afterEach(() => {
    process.stdout.write = original;
  });

  test("shows progress while the row is open, then the row again with its outcome", () => {
    capture();
    const report = new Reporter();
    report.scope("core", 1);
    const close = report.begin("zellij", "mise:github:reddb-io/zellij");
    log.progress("fetch still running — 5s elapsed · 12.0 MB of 84.0 MB (14%) at 2.4 MB/s");
    log.progress("fetch still running — 10s elapsed · 25.0 MB of 84.0 MB (29%) at 2.5 MB/s");
    close("installed");
    process.stdout.write = original;

    const first = out.indexOf("12.0 MB of 84.0 MB");
    const second = out.indexOf("25.0 MB of 84.0 MB");
    const outcome = out.lastIndexOf("zellij");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    // The row is written once more after the last beat, so the outcome
    // mark lands beside the name rather than beside a stale percentage.
    expect(outcome).toBeGreaterThan(second);
  });

  test("progress reaches an outer sink untouched once the row has closed", () => {
    capture();
    const seen: string[] = [];
    const release = progressTo((m) => seen.push(m));
    try {
      const report = new Reporter();
      report.scope("core", 1);
      const close = report.begin("tool", "apt");
      close("installed");
      log.progress("after");
    } finally {
      release();
      process.stdout.write = original;
    }
    expect(seen).toEqual(["after"]);
  });
});
