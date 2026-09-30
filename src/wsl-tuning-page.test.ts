import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { questions } from "./tui-setup-model.ts";

const WSL: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};

const WINDOWS: Platform = {
  os: "windows",
  distro: "windows",
  version: "11",
  codename: "",
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

const DESKTOP: Platform = {
  ...WSL,
  env: "desktop",
  caps: { ...WSL.caps, gui: true, winget: false, flatpak: true },
};

describe("retired WSL resource inventory", () => {
  test("setup no longer promises or enforces a machine resource budget", () => {
    for (const platform of [WSL, WINDOWS, DESKTOP]) {
      expect(questions(platform, [], [], []).map(step => step.id)).not.toContain("wsl-tuning");
    }
  });
});
