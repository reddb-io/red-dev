import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";

import { renderRedwallViaBin } from "./redwall-bin.ts";

describe("the native Redwall byte boundary", () => {
  test("reads the renderer output as a file instead of decoding PNG stdout as text", async () => {
    let output = "";
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const rendered = await renderRedwallViaBin({ state: { workers: 1 }, themeSlug: "dark" }, {
      run: async (_argv, options) => {
        output = options?.env?.["REDWALL_OUT"] ?? "";
        writeFileSync(output, png);
        return { exitCode: 0, stdout: new Uint8Array(), stderr: "" };
      },
    });

    expect(rendered).toEqual(png);
    expect(output).not.toBe("");
    expect(existsSync(output)).toBe(false);
  });
});
