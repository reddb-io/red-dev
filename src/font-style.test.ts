/**
 * The published FiraCode Nerd Font archive has Regular, Light, Medium,
 * Retina, SemiBold and Bold faces — no Italic or BoldItalic. Pointing
 * Alacritty at a face that does not exist makes it fall through to a
 * different font, so one line can visibly change typeface mid-screen.
 */

import { describe, expect, test } from "bun:test";
import { fontSides } from "./wsl.ts";
import type { Platform } from "./platform.ts";
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

describe("every font store the machine has", () => {
  const linux: Platform = {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
  };
  const wsl: Platform = { ...linux, env: "wsl", caps: { ...linux.caps, gui: false, winget: true } };
  const windows: Platform = {
    ...linux,
    os: "windows",
    distro: null,
    version: null,
    codename: null,
    env: "windows",
    caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
  };

  test("a WSL machine has two, and gets both", () => {
    // The report that forced this: the terminal had the glyphs and
    // anything rendering inside the distro did not, because the install
    // branched to Windows and stopped there.
    expect(fontSides(wsl)).toEqual(["linux", "windows"]);
  });

  test("a Linux desktop has one, and native Windows has the other", () => {
    expect(fontSides(linux)).toEqual(["linux"]);
    expect(fontSides(windows)).toEqual(["windows"]);
  });

  test("a server is still a Linux filesystem with a font store", () => {
    // Whether it is worth filling is the manifest's call — the row is
    // desktop-scoped — and not something to answer twice.
    expect(fontSides({ ...linux, env: "server" })).toEqual(["linux"]);
  });
});
