import { describe, expect, test } from "bun:test";

import { pointerEnvironment, unquoteGsetting } from "./pointer-theme.ts";

describe("pointer theme for Alacritty on Wayland", () => {
  test("names the desktop's theme and size the way environment.d reads them", () => {
    const text = pointerEnvironment("Yaru", 24);
    expect(text).toContain("XCURSOR_THEME=Yaru\n");
    expect(text).toContain("XCURSOR_SIZE=24\n");
    // One assignment per line, no `export`, no quotes: environment.d is
    // not a shell.
    for (const line of text.split("\n").filter((l) => l !== "" && !l.startsWith("#"))) {
      expect(line).toMatch(/^[A-Z_]+=[^\s'"]+$/);
    }
  });

  test("reads gsettings' quoted strings back as the bare name", () => {
    expect(unquoteGsetting("'Yaru'\n")).toBe("Yaru");
    expect(unquoteGsetting("'Adwaita'")).toBe("Adwaita");
    expect(unquoteGsetting("Bibata-Modern-Ice")).toBe("Bibata-Modern-Ice");
  });
});
