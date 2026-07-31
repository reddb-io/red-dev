/**
 * Anything that speaks through `log` while the interface is drawing has
 * to be redirected, or it writes over the frame the renderer owns.
 *
 * This is the mechanism behind that, tested directly, because the
 * symptom is only visible as a corrupted screen: "ok shared root is…"
 * and "change it with: red-dev share…" printed across the status line
 * while a stale copy of the progress column stayed beside the live one.
 */

import { describe, expect, test } from "bun:test";
import { captureStart, captureStop, captureTo, log } from "./log.ts";

describe("captureTo", () => {
  test("routes every level into the sink instead of the console", () => {
    const seen: string[] = [];
    const release = captureTo((l) => seen.push(l));
    log.ok("um");
    log.plain("       dois");
    log.skip("tres");
    log.step("quatro");
    log.warn("cinco");
    release();
    expect(seen).toHaveLength(5);
    expect(seen.join("\n")).toContain("um");
    expect(seen.join("\n")).toContain("dois");
    expect(seen.join("\n")).toContain("cinco");
  });

  test("stops routing once released", () => {
    const seen: string[] = [];
    const release = captureTo((l) => seen.push(l));
    release();
    log.plain("depois");
    expect(seen).toHaveLength(0);
  });

  test("the step buffer still wins, so provider chatter stays batched", () => {
    // captureStart/captureStop hold provider output so it lands under
    // its own step. That has to keep working while a sink is installed,
    // or converge lines interleave with the step that produced them.
    const seen: string[] = [];
    const release = captureTo((l) => seen.push(l));
    captureStart();
    log.plain("dentro do passo");
    const held = captureStop();
    log.plain("fora do passo");
    release();
    expect(held.join()).toContain("dentro do passo");
    expect(seen.join()).toContain("fora do passo");
    expect(seen.join()).not.toContain("dentro do passo");
  });
});
