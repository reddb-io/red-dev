import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { themeSurfaceNames } from "./theme-apply.ts";

const basePlatform = {
  distro: null,
  version: null,
  codename: null,
  arch: "x64",
  caps: {
    apt: false,
    gui: true,
    systemd: false,
    winget: true,
    flatpak: false,
  },
} satisfies Omit<Platform, "os" | "env">;

const wsl = {
  ...basePlatform,
  os: "linux",
  env: "wsl",
} satisfies Platform;

const windows = {
  ...basePlatform,
  os: "windows",
  env: "windows",
} satisfies Platform;

describe("theme surfaces", () => {
  test("a theme reaches the desktop and nothing inside the terminal", () => {
    // Nine of the eleven surfaces this used to name were terminal
    // programs. They take the fixed palette now — see
    // src/terminal-surfaces.ts and .red/adr/0002 — so a name reappearing
    // in this list is a theme leaking back into a pane.
    expect(themeSurfaceNames(windows)).toEqual(["vscode", "windows"]);
  });

  test("no terminal program is a theme surface any more", () => {
    const inTheTerminal = ["zellij", "btop", "neovim", "bat", "delta", "lazygit", "opencode", "herdr"];
    for (const p of [windows, wsl]) {
      for (const name of inTheTerminal) {
        expect(themeSurfaceNames(p)).not.toContain(name);
      }
    }
  });

  test("native Windows stays in parity with WSL, apart from GNOME", () => {
    const portable = (name: string) => name !== "gnome";

    expect(themeSurfaceNames(windows).filter(portable)).toEqual(
      themeSurfaceNames(wsl).filter(portable),
    );
  });
});
