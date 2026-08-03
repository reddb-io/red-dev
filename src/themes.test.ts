import { describe, expect, test } from "bun:test";
import { THEMES } from "./themes.ts";

describe("themes", () => {
  test("every theme declares its desktop appearance explicitly", () => {
    for (const [slug, theme] of Object.entries(THEMES)) {
      expect(["light", "dark"], slug).toContain(theme.appearance);
    }
  });

  test("rose-pine is the light Rose Pine Dawn palette", () => {
    expect(THEMES["rose-pine"]?.appearance).toBe("light");
  });
});
