import { describe, expect, test } from "bun:test";
import { parseWslVerbose } from "./wsl-provision.ts";

describe("WSL architecture detection", () => {
  test("parses the default marker and WSL version", () => {
    const output = [
      "  NAME              STATE           VERSION",
      "* Ubuntu-24.04      Running         2",
      "  legacy            Stopped         1",
    ].join("\r\n");

    expect(parseWslVerbose(output)).toEqual([
      { name: "Ubuntu-24.04", default: true, version: 2 },
      { name: "legacy", default: false, version: 1 },
    ]);
  });

  test("tolerates the legacy NUL-separated representation", () => {
    const utf16Looking =
      "*\0 \0U\0b\0u\0n\0t\0u\0 \0 \0R\0u\0n\0n\0i\0n\0g\0 \0 \0" +
      "2\0\r\0\n\0";
    expect(parseWslVerbose(utf16Looking)).toEqual([
      { name: "Ubuntu", default: true, version: 2 },
    ]);
  });

  test("does not invent a version from quiet or malformed output", () => {
    expect(parseWslVerbose("Ubuntu-24.04\r\n")).toEqual([]);
  });
});
