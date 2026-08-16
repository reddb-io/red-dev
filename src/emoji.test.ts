/**
 * The picker's two promises, held against machines it cannot be run on.
 *
 * The first is that the answer does not depend on the machine. The table
 * ships inside the binary, so the same query returns the same rows in
 * the same order on Ubuntu 24, Ubuntu 26, WSL, native Windows and a
 * headless server — and a search that reordered itself per target would
 * be a picker nobody builds muscle memory for.
 *
 * The second is that copying goes through the clipboard the terminal
 * layer already has, not through a second one this feature invented. The
 * WSL route is the one that earns the paranoia: `clip.exe` alone decodes
 * redirected stdin with the Windows OEM code page and turned UTF-8 into
 * mojibake, then a PowerShell bridge decoded correctly and exceeded
 * zellij's one-second deadline, and only iconv-to-BOM-less-UTF-16LE is
 * both correct and fast. A picker whose whole job is putting a
 * supplementary-plane character on the Windows clipboard is exactly the
 * surface that would have written that bug for a third time.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { ACTIONS } from "./actions/index.ts";
import { zellijConfigFor } from "./dotfiles.ts";
import {
  clipboardRoute,
  copyEmoji,
  copyPlan,
  EMOJI,
  emojiColumns,
  emojiLines,
  emojiRow,
  PICKER_START,
  pickerStep,
  searchEmoji,
  writeClipboard,
  type Emoji,
  type PickerKey,
  type PickerState,
} from "./emoji.ts";
import { firePlan } from "./keys.ts";
import type { Platform } from "./platform.ts";

function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

/**
 * The five targets, named the way the product names them.
 *
 * Ubuntu 24 and Ubuntu 26 are two of the five and share one `Env`, which
 * is the point rather than a redundancy: "identical on every target" is
 * a claim about the machines, and the two releases are two machines.
 */
const noble = machine({ version: "24.04", codename: "noble" });
const resolute = machine({ version: "26.04", codename: "resolute" });
const wsl = machine({ env: "wsl", caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false } });
const windows = machine({ os: "windows", env: "windows", distro: null, version: null, codename: null });
const server = machine({ env: "server", caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } });

const FIVE_TARGETS = [noble, resolute, wsl, windows, server];

/** No key pressed; each test turns on the one it means. */
function press(over: Partial<PickerKey> = {}): PickerKey {
  return {
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    backspace: false,
    delete: false,
    ctrl: false,
    ...over,
  };
}

/** Type a string into the picker, one keystroke at a time. */
function typed(text: string): PickerState {
  let state = PICKER_START;
  for (const ch of text) state = pickerStep(state, ch, press()).state;
  return state;
}

/** The characters a query returns, which is the whole observable result. */
function found(query: string): string[] {
  return searchEmoji(query).map((e) => e.char);
}

describe("the table that ships with the binary", () => {
  test("is not read from the machine — the same rows on all five targets", () => {
    // Nothing in the search takes a Platform, and that is the design
    // rather than an omission: a table sourced from installed fonts or
    // from a service would need one, and would answer differently on
    // each of these.
    const once = found("rocket");
    for (const p of FIVE_TARGETS) {
      void p;
      expect(found("rocket")).toEqual(once);
    }
  });

  test("has a unique character on every row", () => {
    // Two rows carrying one character is a duplicate in the list and an
    // ambiguous selection under the cursor, which draws as a second row
    // highlighting itself.
    expect(new Set(EMOJI.map((e) => e.char)).size).toBe(EMOJI.length);
  });

  test("and a unique name, because the name is what the search ranks on", () => {
    expect(new Set(EMOJI.map((e) => e.name)).size).toBe(EMOJI.length);
  });

  test("names are lowercase, so a query never has to guess the case", () => {
    expect(EMOJI.filter((e) => e.name !== e.name.toLowerCase())).toEqual([]);
    expect(EMOJI.filter((e) => e.keywords.some((k) => k !== k.toLowerCase()))).toEqual([]);
  });

  test("no keyword repeats a word already in its own name", () => {
    // It would do nothing — the name is in the haystack already — and a
    // keyword that does nothing reads as a search term that exists.
    const wasted = EMOJI.filter((e) =>
      e.keywords.some((k) => e.name.split(/[\s-]+/).includes(k)),
    );
    expect(wasted.map((e) => e.name)).toEqual([]);
  });

  test("is big enough to be worth a picker", () => {
    expect(EMOJI.length).toBeGreaterThan(150);
  });
});

describe("searching, pinned against a fixture query", () => {
  test("`check` puts the check marks first, in one fixed order", () => {
    // The whole result, not a containment: what this pins is the order,
    // and an assertion that merely found ✅ somewhere would pass for a
    // ranking that put it fourth.
    //
    // 🛒 is in the list because `checkout` is one of its keywords, and it
    // is last because it is the only row whose name does not begin with
    // the query. That is the ranking doing its job rather than noise to
    // be filtered out: someone typing `check` at a shopping cart is not
    // wrong, they are just less likely than the three above it.
    expect(found("check")).toEqual(["✅", "☑️", "✔️", "🛒"]);
  });

  test("a name that is the query outranks every row that merely mentions it", () => {
    // 🔥 is named "fire". 🦊 carries "firefox" as a keyword and would
    // come first on a plain filter in table order, because Animals &
    // Nature lists the fox above the flame.
    expect(found("fire")[0]).toBe("🔥");
    expect(found("fire")).toContain("🦊");
  });

  test("a keyword finds what the name never says", () => {
    // Nothing in "rocket" is the word somebody types when they are
    // shipping something.
    expect(found("deploy")).toEqual(["🚀"]);
    expect(found("lgtm")).toEqual(["👍"]);
  });

  test("every word has to match, in any order", () => {
    expect(found("green circle")).toEqual(["🟢"]);
    expect(found("circle green")).toEqual(["🟢"]);
    expect(found("rocket nonsense")).toEqual([]);
  });

  test("the group is part of the haystack, so `food` is a query", () => {
    const food = searchEmoji("food");
    expect(food.length).toBeGreaterThan(20);
    expect(food.every((e) => e.group === "Food & Drink" || e.name.includes("food"))).toBe(true);
  });

  test("case is folded, because nobody types a name the way it is stored", () => {
    expect(found("ROCKET")).toEqual(found("rocket"));
    expect(found("  Rocket  ")).toEqual(found("rocket"));
  });

  test("with nothing typed, the whole table is visible in declared order", () => {
    expect(searchEmoji("")).toHaveLength(EMOJI.length);
    expect(searchEmoji("   ")[0]?.char).toBe(EMOJI[0]?.char);
  });

  test("and a query that matches nothing returns nothing rather than everything", () => {
    expect(found("zzzznope")).toEqual([]);
  });
});

describe("which clipboard each target copies through", () => {
  test("the route per target, all five pinned at once", () => {
    expect(clipboardRoute(noble)?.target).toBe("wayland");
    expect(clipboardRoute(resolute)?.target).toBe("wayland");
    expect(clipboardRoute(wsl)?.target).toBe("wsl");
    expect(clipboardRoute(windows)?.target).toBe("windows");
    // Not a fourth route. A server has no display, so it has no
    // clipboard, and naming a program that is not installed would be the
    // same silent failure pointed the other way.
    expect(clipboardRoute(server)).toBeNull();
  });

  test("and each one is the command zellij is given on the same machine", () => {
    // The claim that matters: three routes, shared with the terminal
    // layer rather than reimplemented beside it. A copy path that drifted
    // from zellij's would mean selecting text and picking an emoji put
    // different bytes on the same clipboard.
    for (const p of [noble, resolute, wsl, windows]) {
      const route = clipboardRoute(p);
      expect(route).not.toBeNull();
      expect(zellijConfigFor(p)).toContain(`copy_command "${route!.argv.join(" ")}"`);
    }
  });

  test("the WSL route is the existing Unicode-safe bridge, not a new one", () => {
    const route = clipboardRoute(wsl)!;
    expect(route.argv[0]).toBe("bash");
    expect(route.argv[1]).toContain("config/bash/windows-clipboard.sh");
    // Never powershell.exe from inside WSL: correct on encoding and too
    // slow to start, which is the mistake this path already made once.
    expect(route.argv.join(" ")).not.toContain("powershell.exe");
    expect(route.argv.join(" ")).not.toContain("clip.exe");
  });

  test("native Windows takes the PowerShell bridge, which decodes UTF-8 explicitly", () => {
    const route = clipboardRoute(windows)!;
    expect(route.argv[0]).toBe("powershell.exe");
    expect(route.argv).toContain("-EncodedCommand");
    const decoded = Buffer.from(route.argv[3] ?? "", "base64").toString("utf16le");
    expect(decoded).toContain("Set-Clipboard");
    expect(decoded).toContain("Text.Encoding]::UTF8.GetString");
  });

  test("a Linux desktop takes wl-copy, which needs no encoding step at all", () => {
    expect(clipboardRoute(noble)?.argv).toEqual(["wl-copy"]);
  });
});

/**
 * The encoding itself, run rather than asserted about.
 *
 * The three tests above pin which program the picker reaches for. This
 * one pins what comes out of it, because "the same argv" would still be
 * true of a bridge that had been quietly broken — and the failure this
 * whole path exists to prevent is invisible until the bytes are read
 * back: an emoji that arrives on the Windows clipboard as `??`.
 *
 * The emoji is deliberately outside the Basic Multilingual Plane, so it
 * is a surrogate pair in UTF-16 and two different mistakes could mangle
 * it. The accented text beside it is what caught the OEM code page.
 */
describe("what the WSL route actually puts on the clipboard", () => {
  test("the picker's own plan converts to BOM-less UTF-16LE within the deadline", async () => {
    const dir = mkdtempSync(`${tmpdir()}/red-emoji-`);
    const capture = `${dir}/clipboard.bin`;
    const fakeClip = `${dir}/clip.exe`;
    writeFileSync(fakeClip, '#!/bin/sh\nexec tee "$CLIP_CAPTURE" >/dev/null\n');
    chmodSync(fakeClip, 0o755);

    const rocket = EMOJI.find((e) => e.name === "rocket")!;
    const plan = copyPlan(wsl, rocket);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // The script is read from the checkout rather than from ~/.local,
    // which is where a converged machine deploys it: this test is about
    // the bytes the bridge produces, not about whether a converge has
    // run here. The rest of the argv is the plan's own.
    const argv = ["bash", "config/bash/windows-clipboard.sh", ...plan.argv.slice(2)];
    expect(plan.argv[0]).toBe(argv[0]);

    const started = performance.now();
    const proc = Bun.spawn(argv, {
      env: { ...process.env, PATH: `${dir}:${process.env["PATH"] ?? ""}`, CLIP_CAPTURE: capture },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    proc.stdin.write(plan.char);
    proc.stdin.end();

    expect(await proc.exited).toBe(0);
    expect(performance.now() - started).toBeLessThan(1_000);

    const bytes = readFileSync(capture);
    expect(bytes.toString("utf16le")).toBe("🚀");
    // A BOM would arrive in the Windows clipboard as a literal U+FEFF at
    // the front of every paste.
    expect(bytes[0]).not.toBe(0xff);
    // And a surrogate pair is four bytes, which is what proves nothing
    // dropped it to a replacement character on the way through.
    expect(bytes.length).toBe(4);
  });
});

describe("what Enter copies", () => {
  test("the chosen row's character reaches this target's bridge, and nothing else does", async () => {
    const state = typed("rocket");
    const step = pickerStep(state, "", press({ return: true }));
    expect(step.copy?.char).toBe("🚀");

    const handed: { argv: readonly string[]; text: string }[] = [];
    const outcome = await copyEmoji(wsl, step.copy!, async (argv, text) => {
      handed.push({ argv, text });
      return 0;
    });

    expect(outcome.copied).toBe(true);
    expect(handed).toHaveLength(1);
    expect(handed[0]?.text).toBe("🚀");
    expect(handed[0]?.argv[1]).toContain("windows-clipboard.sh");
  });

  test("each target is handed the same character through its own route", async () => {
    const rocket = EMOJI.find((e) => e.name === "rocket")!;
    const reached: string[] = [];
    for (const p of [noble, wsl, windows]) {
      await copyEmoji(p, rocket, async (argv, text) => {
        expect(text).toBe("🚀");
        reached.push(argv[0] ?? "");
        return 0;
      });
    }
    expect(reached).toEqual(["wl-copy", "bash", "powershell.exe"]);
  });

  test("a machine with no clipboard says so, and hands over the character anyway", async () => {
    const rocket = EMOJI.find((e) => e.name === "rocket")!;
    const started: unknown[] = [];
    const outcome = await copyEmoji(server, rocket, async (argv) => {
      started.push(argv);
      return 0;
    });
    expect(outcome.copied).toBe(false);
    expect(outcome.detail).toContain("no clipboard on server");
    expect(outcome.detail).toContain("🚀");
    // Nothing was run. A refusal that still spawned would be a `wl-copy`
    // that is not installed, failing one layer further down.
    expect(started).toEqual([]);
  });

  test("a bridge that fails is reported rather than counted as copied", async () => {
    const rocket = EMOJI.find((e) => e.name === "rocket")!;
    const outcome = await copyEmoji(wsl, rocket, async () => 127);
    expect(outcome.copied).toBe(false);
    expect(outcome.detail).toContain("127");
  });

  test("and a bridge that throws becomes a sentence, not an unhandled rejection", async () => {
    const rocket = EMOJI.find((e) => e.name === "rocket")!;
    const outcome = await copyEmoji(wsl, rocket, async () => {
      throw new Error("interop is disabled");
    });
    expect(outcome.copied).toBe(false);
    expect(outcome.detail).toContain("interop is disabled");
  });

  test("the real write reports a non-zero exit rather than swallowing it", async () => {
    // Through runBounded, against a program certain to exist and certain
    // to fail. The seam above is where the routes are pinned; this is the
    // one line of it that talks to a real process.
    expect(await writeClipboard(["false"], "🚀")).not.toBe(0);
    expect(await writeClipboard(["cat"], "🚀")).toBe(0);
  });
});

describe("the keystrokes the picker reads", () => {
  test("letters are the search box, so j and k cannot be navigation", () => {
    expect(typed("jk").query).toBe("jk");
  });

  test("backspace takes one back, and an empty box swallows it", () => {
    expect(pickerStep(typed("fire"), "", press({ backspace: true })).state.query).toBe("fir");
    expect(pickerStep(PICKER_START, "", press({ backspace: true })).state.query).toBe("");
  });

  test("the arrows move within what is visible and stop at the ends", () => {
    const narrow = typed("check");
    const visible = searchEmoji(narrow.query).length;
    let state = narrow;
    for (let i = 0; i <= visible + 2; i++) {
      state = pickerStep(state, "", press({ downArrow: true })).state;
    }
    expect(state.index).toBe(visible - 1);
    expect(pickerStep(PICKER_START, "", press({ upArrow: true })).state.index).toBe(0);
  });

  test("editing the query puts the cursor back on the first match", () => {
    const moved = pickerStep(PICKER_START, "", press({ downArrow: true })).state;
    expect(pickerStep(moved, "f", press()).state.index).toBe(0);
  });

  test("escape clears a search before it closes the picker", () => {
    const cleared = pickerStep(typed("zzzznope"), "", press({ escape: true }));
    expect(cleared.quit).toBeUndefined();
    expect(cleared.state.query).toBe("");
    expect(pickerStep(PICKER_START, "", press({ escape: true })).quit).toBe(true);
  });

  test("ctrl+c leaves, and no other ctrl chord types into the box", () => {
    expect(pickerStep(PICKER_START, "c", press({ ctrl: true })).quit).toBe(true);
    expect(pickerStep(PICKER_START, "a", press({ ctrl: true })).state.query).toBe("");
  });

  test("enter on a search that found nothing copies nothing", () => {
    expect(pickerStep(typed("zzzznope"), "", press({ return: true })).copy).toBeUndefined();
  });

  test("and a copy leaves the list where it was, because people want three", () => {
    // A picker that closed on the first Enter would make somebody
    // assembling a commit message press the chord again.
    const state = { query: "check", index: 1 };
    const step = pickerStep(state, "", press({ return: true }));
    expect(step.copy?.char).toBe("☑️");
    expect(step.quit).toBeUndefined();
    expect(step.state).toEqual(state);
  });
});

describe("the plain list, for a terminal that cannot draw the picker", () => {
  test("carries every row, with its keywords, so nothing is hidden", () => {
    const lines = emojiLines();
    expect(lines).toHaveLength(EMOJI.length);
    const rocket = lines.find((l) => l.includes("rocket"));
    expect(rocket).toContain("🚀");
    expect(rocket).toContain("Travel & Places");
    expect(rocket).toContain("deploy");
  });

  test("and the columns line up on the widest of each", () => {
    const table: readonly Emoji[] = [
      { char: "🚀", name: "rocket", group: "Travel & Places", keywords: [] },
      { char: "✅", name: "check mark button", group: "Symbols", keywords: [] },
    ];
    const cols = emojiColumns(table);
    expect(cols.name).toBe("check mark button".length);
    expect(cols.group).toBe("Travel & Places".length);
    // Same offset for the group column on both rows, measured after the
    // character. It is not padded and cannot be: 🚀 is a surrogate pair
    // and ✅ is one unit, while a terminal draws both two cells wide, so
    // a column computed from string length would misalign exactly the
    // rows it was meant to align. What red-dev controls is the fixed gap
    // after the character and everything to the right of it.
    const rows = table.map((e) => emojiRow(e, cols).slice(e.char.length));
    expect(rows[0]?.indexOf("Travel")).toBe(rows[1]?.indexOf("Symbols"));
    expect(rows[0]?.startsWith("  ")).toBe(true);
  });

  test("a row with no keywords ends after its group rather than in a stray gap", () => {
    const row = emojiRow(
      { char: "🐼", name: "panda", group: "Animals & Nature", keywords: [] },
      { name: 5, group: 16 },
    );
    expect(row).toBe(row.trimEnd());
  });
});

describe("how the picker is reached", () => {
  test("it is a semantic action, with one chord in the Ctrl+Alt family", () => {
    const action = ACTIONS.find((a) => a.id === "emoji.pick");
    expect(action?.label).toBe("Emoji picker");
    expect(action?.chord).toBe("Ctrl+Alt+E");
    // Opening it reads a table and writes nothing; the clipboard belongs
    // to the signed-in session.
    expect(action?.mutates).toBe(false);
    expect(action?.privileged).toBe(false);
  });

  test("firing it opens a terminal of its own, not a second surface on this frame", () => {
    const anything = (cmd: string): string => `/usr/bin/${cmd}`;

    const onWindows = firePlan("emoji.pick", windows, anything);
    expect(onWindows.ok && onWindows.argv).toEqual([
      "cmd.exe", "/c", "start", "", "red-dev.exe", "emoji",
    ]);

    const onUbuntu = firePlan("emoji.pick", noble, anything);
    expect(onUbuntu.ok && onUbuntu.argv).toEqual(["alacritty", "-e", "red-dev", "emoji"]);

    // And gnome-terminal is told with `--`, whose -e was deprecated
    // years ago: the wrong flag opens a terminal with a shell in it and
    // no sign that the command was dropped.
    const gnome = firePlan("emoji.pick", noble, (cmd) =>
      cmd === "gnome-terminal" ? "/usr/bin/gnome-terminal" : null,
    );
    expect(gnome.ok && gnome.argv).toEqual(["gnome-terminal", "--", "red-dev", "emoji"]);
  });

  test("and a machine with no terminal emulator is told the command to run instead", () => {
    const plan = firePlan("emoji.pick", noble, () => null);
    expect(plan.ok).toBe(false);
    expect(plan.ok === false && plan.detail).toContain("red-dev emoji");
  });
});
