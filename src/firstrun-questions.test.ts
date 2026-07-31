/**
 * The shared root is asked on a first run, and asked first.
 *
 * It was built as a separate command run after the converge had already
 * written every configuration into ~/.config, which made it a place you
 * migrate into rather than where configuration is born. Asking it at all
 * is the correction; asking it before anything writes a file is what
 * makes the correction real.
 *
 * The step list is not exported, so this reads the source. Crude, and it
 * fails on the two things that actually matter: the question
 * disappearing, and it drifting down the list behind something that
 * writes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync("src/tui-setup.ts", "utf8");

/** Question ids in the order they are declared. */
function stepOrder(): string[] {
  return [...src.matchAll(/^\s+id: "([a-z]+)",$/gm)].map((m) => m[1] as string);
}

describe("the first-run questions", () => {
  test("ask about the shared root", () => {
    expect(stepOrder()).toContain("share");
  });

  test("ask it before anything that writes a file", () => {
    // Theme and font both write; if the share is decided after them,
    // their output lands locally and needs migrating — which is the
    // whole problem this was meant to remove.
    const order = stepOrder();
    expect(order.indexOf("share")).toBeLessThan(order.indexOf("theme"));
    expect(order.indexOf("share")).toBeLessThan(order.indexOf("font"));
  });

  test("only where there are two environments to span", () => {
    // Bare-metal Ubuntu and servers have no Windows side, and offering
    // to share with a machine that is not there is not a question.
    const block = src.slice(src.indexOf('id: "share"'), src.indexOf('id: "shell"'));
    expect(block).toContain('pl.env === "wsl" || pl.os === "windows"');
  });

  test("the answer is carried out of the wizard", () => {
    // A question whose answer nothing reads is worse than no question.
    expect(src).toContain('share: get("share")[0] === "yes"');
  });
});
