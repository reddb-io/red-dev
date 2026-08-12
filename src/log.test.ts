/**
 * The two units the narration reports in. Shared with the summary rows,
 * which is the reason they are worth pinning: a row that says 3.4s
 * beside a line that says 3400ms reads as two different measurements of
 * two different things.
 */

import { describe, expect, test } from "bun:test";
import { formatBytes, formatDuration, log, captureStart, captureStop } from "./log.ts";

describe("formatDuration", () => {
  test("sub-second work is milliseconds", () => {
    expect(formatDuration(0)).toBe("0ms");
    expect(formatDuration(340)).toBe("340ms");
  });

  test("seconds carry one decimal, which is what a download needs", () => {
    expect(formatDuration(3400)).toBe("3.4s");
    expect(formatDuration(59_900)).toBe("59.9s");
  });

  test("minutes are minutes and seconds, not 254.0s", () => {
    expect(formatDuration(254_000)).toBe("4m 14s");
  });

  test("a fractional millisecond is not printed as one", () => {
    // performance-style clocks hand this fractions; "0.30000000004ms"
    // in the middle of a converge log is noise nobody asked for.
    expect(formatDuration(0.3)).toBe("0ms");
  });
});

describe("formatBytes", () => {
  test("small payloads stay in bytes", () => {
    expect(formatBytes(512)).toBe("512 B");
  });

  test("the sizes actually downloaded here", () => {
    expect(formatBytes(4_600_000)).toBe("4.4 MB");
    expect(formatBytes(33_000_000)).toBe("31.5 MB");
  });

  test("and it does not run out of units on a gigabyte", () => {
    expect(formatBytes(1_288_490_188)).toBe("1.2 GB");
  });
});

describe("log.info", () => {
  test("is routed like every other level", () => {
    // Narration that bypassed the capture would print over the frame the
    // fullscreen renderer owns — the exact failure the buffer exists for.
    captureStart();
    log.info("downloading something");
    const held = captureStop();
    expect(held).toHaveLength(1);
    expect(held[0]).toContain("downloading something");
  });
});
