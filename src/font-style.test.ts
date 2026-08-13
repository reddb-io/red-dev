/**
 * The published FiraCode Nerd Font archive has Regular, Light, Medium,
 * Retina, SemiBold and Bold faces — no Italic or BoldItalic. Pointing
 * Alacritty at a face that does not exist makes it fall through to a
 * different font, so one line can visibly change typeface mid-screen.
 */

import { describe, expect, test } from "bun:test";
import { fontToml } from "./alacritty.ts";

describe("Alacritty font faces", () => {
  test("never requests the nonexistent FiraCode italic face", () => {
    const toml = fontToml("FiraCode Nerd Font Mono", 11);
    const italic = toml.slice(toml.indexOf("[font.italic]"));
    expect(italic).toContain("style = 'Regular'");
    expect(italic).not.toContain("style = 'Italic'");
  });

  test("keeps real italic faces for families that publish them", () => {
    const toml = fontToml("JetBrainsMono Nerd Font Mono", 11);
    const italic = toml.slice(toml.indexOf("[font.italic]"));
    expect(italic).toContain("style = 'Italic'");
  });
});
