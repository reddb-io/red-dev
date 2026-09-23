/**
 * The interactive terminal is a pipeline, not four independent tools.
 *
 * Alacritty hands bytes to Zellij, Zellij hands them to bash, and ble.sh
 * replaces bash's editor. A setting that is individually valid at each
 * layer can still make one physical key arrive twice or make every key
 * disappear behind Zellij's startup UI. These assertions pin the seams
 * where those regressions happened.
 */

import { describe, expect, test } from "bun:test";
import { keysToml } from "./alacritty.ts";
import { FILES } from "./dotfiles.ts";
import { zellijConfigFor } from "./dotfiles.ts";
import type { Platform } from "./platform.ts";

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

describe("the Alacritty -> Zellij -> bash -> ble.sh input path", () => {
  test("starts Zellij before ble.sh takes ownership of bash input", () => {
    const rc = FILES["rc.sh"] ?? "";
    const zellijPhase = rc.indexOf("for _red_part in path shared build-resources zellij");
    const bleLoad = rc.indexOf('. "$HOME/.local/share/blesh/ble.sh" --noattach');
    const shellInit = rc.indexOf("for _red_part in init aliases functions prompt red-skills-watch");

    expect(zellijPhase).toBeGreaterThan(-1);
    expect(bleLoad).toBeGreaterThan(zellijPhase);
    expect(shellInit).toBeGreaterThan(bleLoad);
  });

  test("does not let Zellij put modal startup UI in front of the shell", () => {
    const config = zellijConfigFor(desktop);
    expect(config).toContain("show_startup_tips false");
    expect(config).toContain("show_release_notes false");
  });

  test("uses the legacy byte path that bash and ble.sh agree on", () => {
    const config = zellijConfigFor(desktop);
    expect(config).toContain("support_kitty_keyboard_protocol false");
  });

  test("leaves plain Backspace to Alacritty's single built-in DEL path", () => {
    const keys = keysToml();
    // Alacritty executes every matching binding. Adding a second binding here
    // would emit DEL once from the built-in and once from generated config.
    expect(keys).not.toContain("key = 'Backspace'");
  });
});
