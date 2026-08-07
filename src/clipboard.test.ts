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
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { zellijConfigAction, zellijConfigFor } from "./dotfiles.ts";
import { repairedImports, requiredImports } from "./alacritty.ts";
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
  test("uses the fast UTF-8 bridge under WSL", () => {
    const config = zellijConfigFor(platform({ env: "wsl" }));
    expect(config).toContain("windows-clipboard.sh");
    expect(config).not.toContain("powershell.exe");
    expect(config).not.toContain('copy_command "clip.exe"');
  });

  test("uses the same Unicode-safe bridge on native Windows", () => {
    const config = zellijConfigFor(platform({ os: "windows", env: "windows" }));
    expect(config).toContain("powershell.exe");
    expect(config).not.toContain('copy_command "clip.exe"');
  });

  test("converts Zellij UTF-8 to BOM-less UTF-16LE within its timeout", async () => {
    const dir = mkdtempSync(`${tmpdir()}/red-clipboard-`);
    const capture = `${dir}/clipboard.bin`;
    const fakeClip = `${dir}/clip.exe`;
    writeFileSync(fakeClip, '#!/bin/sh\nexec tee "$CLIP_CAPTURE" >/dev/null\n');
    chmodSync(fakeClip, 0o755);

    const input = "copiar e colar: ação — 🧪";
    const started = performance.now();
    const proc = Bun.spawn(["bash", "config/bash/windows-clipboard.sh"], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env["PATH"] ?? ""}`,
        CLIP_CAPTURE: capture,
      },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    proc.stdin.write(input);
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(readFileSync(capture).toString("utf16le")).toBe(input);
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
    expect(src).toContain("await putShared(\"keys.toml\", keysToml());");
  });

  test("and that file is repaired into an existing config", () => {
    // requiredImports is what the repair pass writes into an
    // alacritty.toml that predates it.
    expect(requiredImports(null)).toContain("keys.toml");
  });
});

/**
 * The base these two reconstruct, pinned rather than read live.
 *
 * They used to build a historical artifact by appending an old
 * copy_command to whatever config/zellij/config.kdl says today, which
 * only produced the real 0.15.0 bytes for as long as that file never
 * changed. It changed — `theme "red-dev"` came out — and both tests
 * started asserting that a config which was never shipped is one red-dev
 * shipped. They failed loudly, which was luck: the same construction
 * would have gone on passing for an edit that happened not to alter the
 * hash-relevant part.
 *
 * A fixture cannot drift. This is config.kdl at v0.21.0, and it hashes
 * to the 0.11.0-through-0.21.0 entry in SHIPPED_ZELLIJ_CONFIGS.
 */
const BASE_0_21_0 = readFileSync("src/fixtures/zellij-config-0.21.0.kdl", "utf8");

describe("reaching a machine that already has a config", () => {
  test("upgrades the generated clip.exe config that corrupts UTF-8", () => {
    const old = `${BASE_0_21_0}
// Generated for this target by red-dev.
//
// The clipboard zellij should write to. Without it zellij uses OSC 52,
// which asks the terminal to do the copying and cannot tell whether it
// did — so a selection reports success and the clipboard keeps whatever
// was in it.
copy_command "clip.exe"
`;
    const next = zellijConfigFor(platform({ env: "wsl" }));
    expect(zellijConfigAction(old, next)).toBe("upgrade");
  });

  test("upgrades the generated PowerShell bridge that Zellij times out", () => {
    const script =
      "$ProgressPreference='SilentlyContinue';" +
      "$s=[Console]::OpenStandardInput();" +
      "$m=New-Object IO.MemoryStream;" +
      "$s.CopyTo($m);" +
      "Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($m.ToArray()))";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const old = `${BASE_0_21_0}
// Generated for this target by red-dev.
//
// The clipboard zellij should write to. Without it zellij uses OSC 52,
// which asks the terminal to do the copying and cannot tell whether it
// did — so a selection reports success and the clipboard keeps whatever
// was in it.
copy_command "powershell.exe -NoProfile -EncodedCommand ${encoded}"
`;
    const next = zellijConfigFor(platform({ env: "wsl" }));
    expect(zellijConfigAction(old, next)).toBe("upgrade");
  });

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
      "  'cursor.toml',",
      "  'font.toml',",
      "  'shell.toml',",
      "]",
      "",
      "[window]",
      "opacity = 0.98",
    ].join("\n");
    const after = repairedImports(before, requiredImports(null));
    expect(after).not.toBeNull();
    expect(after).toContain("keys.toml");
    // And keeps what was already there.
    expect(after).toContain("cursor.toml");
    expect(after).toContain("opacity = 0.98");
  });

  test("the retired theme.toml is dropped rather than carried", () => {
    // theme.toml held twenty ANSI values. A machine that converged
    // before red-dev stopped colouring terminals still imports it, and
    // Alacritty would keep applying it — so the entry has to go, not
    // just the file. It is counted as ours precisely so this can happen.
    const before = [
      "[general]",
      "import = [",
      "  'theme.toml',",
      "  'font.toml',",
      "  'shell.toml',",
      "]",
    ].join("\n");
    const after = repairedImports(before, requiredImports(null));
    expect(after).not.toBeNull();
    expect(after).not.toContain("theme.toml");
    expect(after).toContain("cursor.toml");
  });

  test("says nothing to repair when the imports are complete", () => {
    const complete = [
      "[general]",
      "import = [",
      "  'cursor.toml',",
      "  'font.toml',",
      "  'shell.toml',",
      "  'keys.toml',",
      "]",
    ].join("\n");
    expect(repairedImports(complete, requiredImports(null))).toBeNull();
  });

  test("is a pure function, so it can repair across the WSL boundary", () => {
    // The reason this exists. The first version did its own file IO and
    // was guarded on not being WSL at its only call site — so the one
    // target whose config lives on the far side of a boundary was the
    // one target that could never be repaired.
    const before = "[general]\nimport = [\n  'cursor.toml',\n]";
    expect(repairedImports(before, requiredImports(null))).toContain("keys.toml");
  });
});

/**
 * Moving cursor, font and keys into the share changes what an existing
 * alacritty.toml has to say, on a file this project promises to write
 * once and leave alone. The repair pass is the only way those machines
 * ever point at the share.
 */
describe("imports when there is a shared root", () => {
  const SHARE = "C:\\Users\\filip\\.red\\dev";
  const shareDir = `${SHARE}\\config\\alacritty`;

  test("the shared parts are absolute and the local one is not", () => {
    const req = requiredImports(SHARE);
    expect(req).toContain(`${shareDir}\\cursor.toml`);
    expect(req).toContain(`${shareDir}\\font.toml`);
    expect(req).toContain(`${shareDir}\\keys.toml`);
    // shell.toml names wsl.exe or bash.exe: it is the machine's answer
    // to WSL-or-native and must not follow the theme to another machine.
    expect(req).toContain("shell.toml");
    expect(req).not.toContain(`${shareDir}\\shell.toml`);
  });

  test("a relative entry is replaced by the shared one, not joined by it", () => {
    // The bug this guards: appending left both 'cursor.toml' and the
    // absolute path in the list, with the stale local copy still on
    // disk. Which one won depended on merge order.
    const before = [
      "[general]",
      "import = [",
      "  'cursor.toml',",
      "  'font.toml',",
      "  'shell.toml',",
      "  'keys.toml',",
      "]",
    ].join("\n");
    const after = repairedImports(before, requiredImports(SHARE));
    expect(after).not.toBeNull();
    expect(after).toContain(`${shareDir}\\cursor.toml`);
    expect(after).not.toMatch(/^\s*'cursor\.toml',$/m);
    expect(after).toMatch(/^\s*'shell\.toml',$/m);
  });

  test("an import the user added is kept", () => {
    const before = [
      "[general]",
      "import = [",
      "  'cursor.toml',",
      "  'my-overrides.toml',",
      "]",
    ].join("\n");
    const after = repairedImports(before, requiredImports(SHARE));
    expect(after).toContain("my-overrides.toml");
  });

  test("a root that moved is repointed rather than duplicated", () => {
    // Exactly what the .reddev to .red\dev migration leaves behind: a
    // valid absolute import at an address nothing writes to any more.
    const before = [
      "[general]",
      "import = [",
      "  'C:\\Users\\filip\\.reddev\\config\\alacritty\\theme.toml',",
      "  'shell.toml',",
      "]",
    ].join("\n");
    const after = repairedImports(before, requiredImports(SHARE));
    // The old address goes and the new one arrives — and theme.toml does
    // not come back under it, because it is retired rather than moved.
    expect(after).toContain(`${shareDir}\\cursor.toml`);
    expect(after).not.toContain("theme.toml");
    expect(after).not.toContain(".reddev");
  });

  test("nothing to repair once it already points at the share", () => {
    const req = requiredImports(SHARE);
    const settled = `[general]\nimport = [\n${req.map((i) => `  '${i}',`).join("\n")}\n]`;
    expect(repairedImports(settled, req)).toBeNull();
  });
});
