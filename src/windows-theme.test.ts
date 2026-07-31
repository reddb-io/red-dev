/**
 * Windows stores its accent as 0xAABBGGRR.
 *
 * Not the order the name suggests, and not the order anyone guesses.
 * The value on the machine that found this was 0xFFD47800 while
 * Windows' own default accent is #0078D4 — only one byte order makes
 * those the same colour, which is how the format was established rather
 * than by reading documentation.
 *
 * Getting it backwards is silent: the accent is set, it is simply the
 * wrong colour, and nothing reports anything.
 */

import { describe, expect, test } from "bun:test";
import { accentDword } from "./windows-theme.ts";

describe("accentDword", () => {
  test("Windows' own default round-trips", () => {
    // #0078D4 is what Windows ships with, and 0xFFD47800 is what the
    // registry held for it.
    expect(accentDword("#0078D4")).toBe(0xffd47800);
  });

  test("accepts a hex with or without the hash", () => {
    expect(accentDword("0078D4")).toBe(accentDword("#0078D4"));
  });

  test("gruvbox yellow", () => {
    // #D79921 -> R=D7 G=99 B=21 -> 0xFF2199D7
    expect(accentDword("#D79921")).toBe(0xff2199d7);
  });

  test("stays unsigned, because the alpha byte overflows a signed int", () => {
    // The first version produced -7830203 and PowerShell refused it.
    expect(accentDword("#458588")).toBeGreaterThan(0);
    expect(accentDword("#000000")).toBe(0xff000000);
  });
});
