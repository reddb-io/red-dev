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
  test("native Windows receives the full portable CLI surface set", () => {
    expect(themeSurfaceNames(windows)).toEqual([
      "zellij",
      "btop",
      "neovim",
      "vscode",
      "bat",
      "delta",
      "lazygit",
      "opencode",
      "herdr",
      "windows",
    ]);
  });

  test("native Windows stays in parity with WSL for portable CLI surfaces", () => {
    const portable = (name: string) => name !== "gnome";

    expect(themeSurfaceNames(windows).filter(portable)).toEqual(
      themeSurfaceNames(wsl).filter(portable),
    );
  });
});
