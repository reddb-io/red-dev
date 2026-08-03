import { describe, expect, test } from "bun:test";
import { decodeWindowsOutput } from "./windows-output.ts";

describe("native Windows output", () => {
  test("keeps UTF-8 as UTF-8", () => {
    const bytes = new TextEncoder().encode("“WSL” é configuração rápida");
    expect(decodeWindowsOutput(bytes)).toBe("“WSL” é configuração rápida");
  });

  test("decodes redirected wsl.exe UTF-16LE without losing accents", () => {
    const bytes = Buffer.from("* Distribuição  Running  2\r\n", "utf16le");
    expect(decodeWindowsOutput(bytes)).toBe("* Distribuição  Running  2\r\n");
  });

  test("recognises an explicit UTF-16LE byte-order mark", () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("ação", "utf16le")]);
    expect(decodeWindowsOutput(bytes)).toBe("ação");
  });
});
