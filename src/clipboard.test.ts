/**
 * "Copied!" that copied nothing.
 *
 * Selecting text in zellij reported success and left the clipboard
 * holding whatever was in it before. Without a copy_command zellij
 * copies through OSC 52 — it asks the terminal to set the clipboard and
 * has no way to learn whether the terminal did — and on Windows that ask
 * goes unanswered often enough that the report is simply wrong.
 *
 * omakub does not configure this at all, which is defensible on the one
 * target it has: an X11 or Wayland session where the terminal answers.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { zellijConfigFor } from "./dotfiles.ts";
import { repairedImports } from "./alacritty.ts";
import type { Platform } from "./platform.ts";

function platform(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  } as Platform;
}

describe("where zellij puts a copied selection", () => {
  test("goes through clip.exe under WSL", () => {
    // Verified from a distro before this was written: piping into
    // clip.exe and reading Get-Clipboard back returns the same text.
    const config = zellijConfigFor(platform({ env: "wsl" }));
    expect(config).toContain('copy_command "clip.exe"');
  });

  test("goes through clip.exe on native Windows too", () => {
    const config = zellijConfigFor(platform({ os: "windows", env: "windows" }));
    expect(config).toContain('copy_command "clip.exe"');
  });

  test("uses the Wayland tool on a Linux desktop", () => {
    expect(zellijConfigFor(platform({ env: "desktop" }))).toContain('copy_command "wl-copy"');
  });

  test("names no command on a server, where there is no clipboard", () => {
    // A copy_command naming a program that is not installed is the same
    // silent failure pointed the other way.
    expect(zellijConfigFor(platform({ env: "server" }))).not.toContain("copy_command");
  });

  test("keeps everything the shipped config says", () => {
    // The per-target line is an addition, not a replacement: losing the
    // keybindings to gain a clipboard would be a poor trade.
    const config = zellijConfigFor(platform({ env: "wsl" }));
    expect(config).toContain('default_mode "locked"');
    expect(config).toContain("copy_on_select true");
  });
});

describe("paste", () => {
  // Read from the source: the generator is private, and what matters is
  // that the file is generated at all rather than living in the
  // write-once config where a later correction could never reach it.
  const src = readFileSync("src/alacritty.ts", "utf8");

  test("binds Ctrl+V, which is what the rest of Windows uses", () => {
    expect(src).toContain("mods = 'Control'");
    expect(src).toContain("action = 'Paste'");
  });

  test("keeps Ctrl+Shift+V, which is what Alacritty ships", () => {
    expect(src).toContain("mods = 'Control|Shift'");
  });

  test("lives in a file red-dev rewrites", () => {
    // In alacritty.toml it would never reach a machine that already had
    // one — the mistake that kept a deprecation warning alive for two
    // releases.
    expect(src).toContain("await put(\"keys.toml\", keysToml());");
  });

  test("and that file is repaired into an existing config", () => {
    // REQUIRED_IMPORTS is what the repair pass adds to an alacritty.toml
    // that predates it.
    expect(src).toContain("'keys.toml'");
    const block = src.slice(src.indexOf("const REQUIRED_IMPORTS"));
    expect(block.slice(0, 120)).toContain("keys.toml");
  });
});

describe("reaching a machine that already has a config", () => {
  test("the config being shipped is registered as shipped", () => {
    // The upgrade only fires for a file that hashes to something
    // red-dev is known to have written. Leaving the current one out is
    // how 0.11.0's config became unupgradable — locked mode had landed,
    // so it did not look stale, and the copy_command could never be
    // added to it. Editing config.kdl means adding its hash here.
    const shipped = readFileSync("config/zellij/config.kdl", "utf8");
    const digest = new Bun.CryptoHasher("sha256").update(shipped).digest("hex");
    const src = readFileSync("src/dotfiles.ts", "utf8");
    expect(src).toContain(digest);
  });

  test("an alacritty.toml gains an import added after it was written", () => {
    const before = [
      "[general]",
      "import = [",
      "  'theme.toml',",
      "  'font.toml',",
      "  'shell.toml',",
      "]",
      "",
      "[window]",
      "opacity = 0.98",
    ].join("\n");
    const after = repairedImports(before);
    expect(after).not.toBeNull();
    expect(after).toContain("keys.toml");
    // And keeps what was already there.
    expect(after).toContain("theme.toml");
    expect(after).toContain("opacity = 0.98");
  });

  test("says nothing to repair when the imports are complete", () => {
    const complete = [
      "[general]",
      "import = [",
      "  'theme.toml',",
      "  'font.toml',",
      "  'shell.toml',",
      "  'keys.toml',",
      "]",
    ].join("\n");
    expect(repairedImports(complete)).toBeNull();
  });

  test("is a pure function, so it can repair across the WSL boundary", () => {
    // The reason this exists. The first version did its own file IO and
    // was guarded on not being WSL at its only call site — so the one
    // target whose config lives on the far side of a boundary was the
    // one target that could never be repaired.
    const before = "[general]\nimport = [\n  'theme.toml',\n]";
    expect(repairedImports(before)).toContain("keys.toml");
  });
});
