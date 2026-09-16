/**
 * Every config red-dev generates, read back by a real parser.
 *
 * The configs are template strings, and a template string can be invalid
 * in ways no substring assertion notices. Two `[general]` tables in
 * alacritty.toml passed every test this project had — each test looked for
 * the text it cared about, and the text was there — while Alacritty
 * rejected the whole file and loaded none of its imports.
 *
 * TOML goes through smol-toml, a strict TOML 1.0 parser that refuses a
 * redefined table or key the way Alacritty's `toml` crate does. KDL goes
 * through a KDL v1 parser, the dialect zellij reads, and then asks the
 * question KDL itself does not: whether a node zellij reads once was
 * written twice, since zellij would silently keep only one of them.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { parse as parseKdl } from "@bgotink/kdl/v1-compat";
import type { Document, Node } from "@bgotink/kdl";
import { parse as parseToml } from "smol-toml";
import {
  fontToml,
  gitBashShellSection,
  keysToml,
  mainToml,
  repairAlacrittyToml,
  requiredImports,
  wslShellSection,
} from "./alacritty.ts";
import { convergeClaudeKeybinding } from "./claude-keybindings.ts";
import { withCodexStatusline } from "./codex-statusline.ts";
import { zellijConfigFor } from "./dotfiles.ts";
import { herdrDashboardBlock } from "./herdr.ts";
import { miseEntries, renderMiseConfig } from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import { cursorToml } from "./terminal-cursor.ts";
import { convergeOpenCodeInput } from "./terminal-surfaces.ts";
import { mergeWindowsTerminalAgentActions } from "./wsl.ts";
import { composeZellijLayers, ZELLIJ_LAYER_TEMPLATE } from "./zellij-layer.ts";

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

const PLATFORMS: Record<string, Platform> = {
  "ubuntu desktop": platform({}),
  "ubuntu server": platform({ env: "server", caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } }),
  wsl: platform({ env: "wsl" }),
  windows: platform({ os: "windows", distro: null, version: null, codename: null, env: "windows" }),
};

const SHARE = "C:\\Users\\someone\\.red\\dev";

function strictToml(text: string): Record<string, unknown> {
  return parseToml(text) as Record<string, unknown>;
}

describe("alacritty TOML", () => {
  for (const share of [null, SHARE]) {
    for (const style of ["top-level", "general"] as const) {
      test(`alacritty.toml parses with a ${style} import${share ? " into the share" : ""}`, () => {
        const required = requiredImports(share);
        const doc = strictToml(mainToml(90, required, style));
        const imports = style === "top-level" ? doc["import"] : (doc["general"] as Record<string, unknown>)["import"];
        expect(imports).toEqual(required);
        // Exactly one spelling, never both.
        if (style === "top-level") expect(doc["general"]).toBeUndefined();
        else expect(doc["import"]).toBeUndefined();
      });
    }
  }

  test("an existing file repaired for either version still parses", () => {
    for (const style of ["top-level", "general"] as const) {
      const fresh = mainToml(90, requiredImports(null), style);
      for (const v of [[0, 13, 2], [0, 15, 1], null] as const) {
        const out = repairAlacrittyToml(fresh, requiredImports(SHARE), v);
        expect(out.kind).toBe("repaired");
        if (out.kind === "repaired") expect(() => strictToml(out.text)).not.toThrow();
      }
    }
  });

  test("keys.toml parses", () => {
    const doc = strictToml(keysToml()) as { keyboard: { bindings: unknown[] } };
    expect(doc.keyboard.bindings.length).toBeGreaterThan(0);
  });

  test("font.toml parses for every family red-dev offers", () => {
    for (const family of ["JetBrainsMono Nerd Font", "FiraCode Nerd Font Mono", "CaskaydiaMono Nerd Font"]) {
      expect(() => strictToml(fontToml(family, 11))).not.toThrow();
    }
  });

  test("cursor.toml parses", () => {
    expect(() => strictToml(cursorToml())).not.toThrow();
  });

  test("shell.toml parses for WSL and Git Bash", () => {
    const wsl = strictToml(wslShellSection("Ubuntu-24.04")) as { terminal: { shell: { args: string[] } } };
    expect(wsl.terminal.shell.args).toEqual(["-d", "Ubuntu-24.04", "--cd", "~"]);
    const bash = strictToml(gitBashShellSection("C:\\Program Files\\Git\\bin\\bash.exe")) as {
      terminal: { shell: { program: string } };
    };
    expect(bash.terminal.shell.program).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
  });
});

describe("other generated TOML", () => {
  test("the shipped starship.toml parses", () => {
    expect(() => strictToml(readFileSync("config/bash/starship.toml", "utf8"))).not.toThrow();
  });

  for (const [name, p] of Object.entries(PLATFORMS)) {
    test(`the mise fragment parses on ${name}`, () => {
      expect(() => strictToml(renderMiseConfig(miseEntries(p)))).not.toThrow();
    });

    test(`the herdr block parses appended to a config that already binds keys on ${name}`, () => {
      const mine = '[keys]\nprefix = "ctrl+b"\n\n[[keys.command]]\nkey = "prefix+g"\ntype = "shell"\ncommand = "lazygit"\n';
      const doc = strictToml(`${mine}\n${herdrDashboardBlock(p)}`) as { keys: { command: unknown[] } };
      expect(doc.keys.command.length).toBe(2);
    });
  }

  test("the codex statusline parses whichever way config.toml spelled tui", () => {
    for (const source of ["", "model = 'x'\n", "[tui]\nnotifications = true\n", "tui.status_line = ['a']\n", "[tui.theme]\nname = 'x'\n"]) {
      expect(() => strictToml(withCodexStatusline(source))).not.toThrow();
    }
  });
});

/** Nodes zellij may legitimately repeat at one level. Everything else it reads once. */
const REPEATABLE = new Set(["bind", "unbind"]);

function duplicates(nodes: readonly Node[], key: (n: Node) => string): string[] {
  const seen = new Set<string>();
  const dup: string[] = [];
  for (const n of nodes) {
    const k = key(n);
    if (seen.has(k)) dup.push(k);
    seen.add(k);
  }
  return dup;
}

/** Names and arguments: `shared_among "locked" "normal"` is one block, `bind "a"` one binding. */
function identity(n: Node): string {
  return [n.getName(), ...n.getArguments().map(String)].join(" ");
}

function assertZellijShape(doc: Document): void {
  expect(duplicates(doc.nodes, (n) => n.getName())).toEqual([]);
  const keybinds = doc.nodes.find((n) => n.getName() === "keybinds");
  for (const mode of keybinds?.children?.nodes ?? []) {
    const binds = (mode.children?.nodes ?? []).filter((b) => REPEATABLE.has(b.getName()));
    expect(duplicates(binds, (b) => b.getArguments().map(String).join(" "))).toEqual([]);
  }
  if (keybinds) expect(duplicates(keybinds.children?.nodes ?? [], identity)).toEqual([]);
}

describe("zellij KDL", () => {
  for (const [name, p] of Object.entries(PLATFORMS)) {
    test(`config.kdl parses and names each setting once on ${name}`, () => {
      assertZellijShape(parseKdl(zellijConfigFor(p)));
    });

    test(`config.kdl composed with layers still does on ${name}`, () => {
      const companion = 'keybinds {\n    shared_among "locked" "normal" {\n        bind "Alt d" { Run "red-skills" "dashboard"; }\n    }\n}\n';
      const layer = [
        ZELLIJ_LAYER_TEMPLATE,
        'copy_command "my-clipboard"',
        "scroll_buffer_size 100000",
        'keybinds {\n    locked {\n        bind "Ctrl g" { SwitchToMode "pane"; }\n    }\n}',
      ].join("\n");
      const composed = composeZellijLayers(zellijConfigFor(p), [companion, layer]);
      const doc = parseKdl(composed);
      assertZellijShape(doc);
      const copy = doc.nodes.filter((n) => n.getName() === "copy_command");
      expect(copy.map((n) => n.getArgument(0))).toEqual(["my-clipboard"]);
    });
  }
});

describe("generated JSON", () => {
  test("Claude Code keybindings.json parses", async () => {
    const path = `${mkdtempSync(`${tmpdir()}/claude-keys-`)}/keybindings.json`;
    await convergeClaudeKeybinding(path);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  test("RedCode tui.json parses", async () => {
    const path = `${mkdtempSync(`${tmpdir()}/redcode-`)}/tui.json`;
    await convergeOpenCodeInput(path);
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  test("Windows Terminal actions converge once, in either settings shape", () => {
    const legacy = mergeWindowsTerminalAgentActions([]).actions;
    expect(mergeWindowsTerminalAgentActions(legacy).added).toEqual([]);
    expect(JSON.parse(JSON.stringify(legacy))).toEqual(legacy);
  });
});
