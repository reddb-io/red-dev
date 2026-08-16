/**
 * The half of config.kdl a converge never writes.
 *
 * zellij has no include mechanism and red-dev regenerates its config
 * whole, so until now a keybinding someone added was lost the next time
 * anything upgraded the file — silently, which is the part that made it
 * a bug rather than a policy. ADR 0007 says every owned file has a user
 * layer; this is zellij's, and because the program cannot include it,
 * red-dev composes.
 *
 * What has to stay true: the layer wins, a converge rewrites the owned
 * file and not the layer, and a machine that never wrote a layer keeps
 * receiving the bytes red-dev has always written it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { installZellijConfig, zellijConfigFor } from "./dotfiles.ts";
import { checkTheme } from "./drift.ts";
import type { Platform } from "./platform.ts";
import {
  composeZellijConfig,
  isComposedZellijConfig,
  ZELLIJ_LAYER_FILE,
  ZELLIJ_LAYER_TEMPLATE,
} from "./zellij-layer.ts";
import base from "../config/zellij/config.kdl" with { type: "text" };

/** A server: no clipboard command, so the base is the shipped file and
 * nothing in these tests depends on which target it ran on. */
const LINUX: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "server",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false },
};

const saved = { home: process.env["HOME"], share: process.env["RED_SHARE_WIN"] };

afterEach(() => {
  for (const [key, value] of [
    ["HOME", saved.home],
    ["RED_SHARE_WIN", saved.share],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/** A home with nothing in it, which is where a converge starts. */
function machine(): { home: string; config: string; layer: string } {
  const home = mkdtempSync(`${tmpdir()}/red-layer-`);
  process.env["HOME"] = home;
  delete process.env["RED_SHARE_WIN"];
  return {
    home,
    config: `${home}/.config/zellij/config.kdl`,
    layer: `${home}/.config/zellij/${ZELLIJ_LAYER_FILE}`,
  };
}

const QUIT = 'keybinds {\n    shared_except "locked" {\n        bind "Ctrl y" { Quit; }\n    }\n}\n';

describe("composing the layer in", () => {
  test("a keybinding in the layer survives regenerating the owned file", async () => {
    const m = machine();
    await installZellijConfig(LINUX);
    writeFileSync(m.layer, QUIT);

    // The whole point: config.kdl is rewritten from scratch and the
    // binding is still there afterwards.
    await installZellijConfig(LINUX);
    const written = readFileSync(m.config, "utf8");
    expect(written).toContain('bind "Ctrl y" { Quit; }');
    expect(isComposedZellijConfig(written)).toBe(true);

    // And again, because "survives one regeneration" is not the claim.
    await installZellijConfig(LINUX);
    expect(readFileSync(m.config, "utf8")).toBe(written);
  });

  test("a converge reports no drift when only the layer changed", async () => {
    const m = machine();
    await installZellijConfig(LINUX);
    writeFileSync(m.layer, QUIT);
    await installZellijConfig(LINUX);

    const checks = await checkTheme(LINUX);
    expect(checks.filter((c) => c.status === "drift")).toEqual([]);
    expect(checks.find((c) => c.name === "zellij layer")?.status).toBe("ok");
  });

  test("a layer the converge has not composed yet is the drift", async () => {
    // The same machine one step earlier. Reporting nothing here would
    // leave someone staring at a keybinding that does not work.
    const m = machine();
    await installZellijConfig(LINUX);
    writeFileSync(m.layer, QUIT);

    const check = (await checkTheme(LINUX)).find((c) => c.name === "zellij layer");
    expect(check?.status).toBe("drift");
    expect(check?.fix).toBe("red-dev install core");
  });

  test("a config.kdl the person wrote is left alone, and says why", async () => {
    // A converge may replace everything red-dev wrote. This is not that:
    // the file predates the layer and belongs to whoever wrote it, so
    // the layer cannot be composed into it and the drift says so rather
    // than the converge overwriting it.
    const m = machine();
    mkdirSync(`${m.home}/.config/zellij`, { recursive: true });
    const mine = 'default_mode "locked"\nmouse_mode false\n';
    writeFileSync(m.config, mine);
    writeFileSync(m.layer, QUIT);

    await installZellijConfig(LINUX);
    expect(readFileSync(m.config, "utf8")).toBe(mine);

    const check = (await checkTheme(LINUX)).find((c) => c.name === "zellij layer");
    expect(check?.status).toBe("drift");
    expect(check?.detail).toContain("yours");
  });
});

describe("the layer itself", () => {
  test("a converge creates it once and never writes it again", async () => {
    const m = machine();
    await installZellijConfig(LINUX);
    expect(readFileSync(m.layer, "utf8")).toBe(ZELLIJ_LAYER_TEMPLATE);

    writeFileSync(m.layer, QUIT);
    await installZellijConfig(LINUX);
    await installZellijConfig(LINUX);
    expect(readFileSync(m.layer, "utf8")).toBe(QUIT);
  });

  test("the seeded layer changes nothing", async () => {
    // It is comments, and comments declare nothing. A machine that never
    // opens the file keeps getting exactly the config red-dev has always
    // written — including the bytes the upgrade hashes recognise.
    const m = machine();
    await installZellijConfig(LINUX);
    expect(readFileSync(m.config, "utf8")).toBe(zellijConfigFor(LINUX));
    expect(existsSync(m.layer)).toBe(true);
  });
});

describe("composition order", () => {
  test("the layer wins over red-dev's base", () => {
    const composed = composeZellijConfig(base, 'scroll_buffer_size 100000\n');
    expect(composed).toContain("scroll_buffer_size 100000");
    expect(composed).not.toContain("scroll_buffer_size 50000");
  });

  test("a rebound key replaces red-dev's, in the mode it names", () => {
    const composed = composeZellijConfig(
      base,
      'keybinds {\n    locked {\n        bind "Ctrl g" { SwitchToMode "pane"; }\n    }\n}\n',
    );
    expect(composed).toContain('bind "Ctrl g" { SwitchToMode "pane"; }');
    expect(composed).not.toContain('bind "Ctrl g" { SwitchToMode "normal"; }');
  });

  test("naming one mode keeps every binding in the others", () => {
    // The alternative — the layer's keybinds block replacing red-dev's —
    // would make adding one binding cost you the other hundred, which is
    // the same data loss the layer exists to end.
    const composed = composeZellijConfig(base, QUIT);
    expect(composed).toContain('bind "Ctrl y" { Quit; }');
    expect(composed).toContain('bind "Shift Enter" { Write 27 91 49 51 59 50 117; }');
    expect(composed).toContain('bind "Tab" { ToggleTab; }');
    expect(composed).toContain('default_mode "locked"');
  });

  test("keybinds is merged rather than repeated", () => {
    // zellij has no include mechanism and no answer for a document that
    // declares the same node twice. Composing means emitting it once.
    const composed = composeZellijConfig(base, QUIT);
    expect(composed.match(/^keybinds\b/gm)?.length).toBe(1);
  });

  test("clear-defaults stays red-dev's unless the layer says otherwise", () => {
    expect(composeZellijConfig(base, QUIT)).toContain("keybinds clear-defaults=true {");
    expect(
      composeZellijConfig(base, 'keybinds clear-defaults=false {\n    locked {\n    }\n}\n'),
    ).toContain("keybinds clear-defaults=false {");
  });

  test("unbinding a key red-dev bound leaves one node, not two", () => {
    // `unbind "Ctrl g"` beside `bind "Ctrl g"` is a document arguing with
    // itself. The layer's verb is the one that survives.
    const composed = composeZellijConfig(
      base,
      'keybinds {\n    locked {\n        unbind "Ctrl g"\n    }\n}\n',
    );
    // Asked of the mode and not of the file: `Ctrl g` is bound in other
    // modes too, and the layer named only this one.
    const locked = /^    locked \{$([\s\S]*?)^    \}$/m.exec(composed)?.[1] ?? "";
    expect(locked).toContain('unbind "Ctrl g"');
    expect(locked).not.toContain('bind "Ctrl g" {');
  });

  test("a mode red-dev never named is added whole", () => {
    const composed = composeZellijConfig(
      base,
      'keybinds {\n    tmux {\n        bind "Ctrl b" { SwitchToMode "normal"; }\n    }\n}\n',
    );
    expect(composed).toContain("    tmux {");
    expect(composed).toContain('        bind "Ctrl b" { SwitchToMode "normal"; }');
  });

  test("nothing else in the base moves", () => {
    // A composition that reformatted the file would make every converge
    // look like a change and bury the one line that was.
    const composed = composeZellijConfig(base, 'scroll_buffer_size 100000\n');
    const removed = base
      .split("\n")
      .filter((line) => !composed.includes(line))
      .filter((line) => line.trim());
    expect(removed).toEqual(["scroll_buffer_size 50000"]);
  });

  test("a layer that declares nothing composes to the base, byte for byte", () => {
    expect(composeZellijConfig(base, null)).toBe(base);
    expect(composeZellijConfig(base, "")).toBe(base);
    expect(composeZellijConfig(base, ZELLIJ_LAYER_TEMPLATE)).toBe(base);
  });
});
