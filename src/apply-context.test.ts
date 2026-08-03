import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import {
  applyContextForEntry,
  type ApplyContextEntryPath,
  type InvocationDefaults,
} from "./preferences.ts";
import type { Platform } from "./platform.ts";

const linux: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: true },
};

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  process.env["HOME"] = mkdtempSync(`${tmpdir()}/red-dev-prefs-`);
  try {
    mkdirSync(`${process.env["HOME"]}/.config/alacritty`, { recursive: true });
    await Bun.write(
      `${process.env["HOME"]}/.config/alacritty/red-dev.json`,
      JSON.stringify({ theme: "gruvbox", font: "jetbrainsmono", fontSize: 14 }) + "\n",
    );
    return await run();
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

const defaults: InvocationDefaults = {
  themeName: "tokyo-night",
  font: "firacode",
  opacity: 90,
};

describe("apply context preferences", () => {
  test("a theme switch context preserves a persisted non-default font and size", async () => {
    await withHome(async () => {
      const ctx = await applyContextForEntry(linux, defaults, "theme");

      expect(ctx).toMatchObject({
        theme: "gruvbox",
        font: "jetbrainsmono",
        fontSize: 14,
      });
    });
  });

  test("all apply entry paths hydrate through the same preference seam", async () => {
    await withHome(async () => {
      const entries: ApplyContextEntryPath[] = ["plan", "install", "update", "theme"];
      const contexts = await Promise.all(
        entries.map((entry) => applyContextForEntry(linux, defaults, entry)),
      );

      expect(contexts.map((ctx) => [ctx.theme, ctx.font, ctx.fontSize])).toEqual([
        ["gruvbox", "jetbrainsmono", 14],
        ["gruvbox", "jetbrainsmono", 14],
        ["gruvbox", "jetbrainsmono", 14],
        ["gruvbox", "jetbrainsmono", 14],
      ]);
    });
  });
});
