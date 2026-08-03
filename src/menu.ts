/**
 * The interactive menu.
 *
 * The previous one was a flat list that ran a single action and exited,
 * so changing a theme and then a font meant invoking the tool twice.
 * omakub's is a loop with submenus and a `<< Back` on every one, and
 * that difference is most of why its setup feels like a program rather
 * than a series of commands.
 *
 * Everything here is reachable non-interactively too — `red-dev theme
 * gruvbox` does what the theme submenu does. The menu is a convenience
 * over the commands, never the only way to reach something.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { THEMES, themeNames } from "./themes.ts";
import { banner, number, select } from "./ui.ts";
import type { Invocation } from "./cli.ts";
import { summary } from "./platform.ts";

const BACK = "<< Back";

/**
 * select() wants a provably non-empty list, and a spread produces
 * `[...string[], string]`, which TypeScript will not narrow. Asserting
 * once here beats a cast at every call site — and an empty menu is a
 * bug worth throwing on rather than rendering.
 */
function options(...items: string[]): [string, ...string[]] {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error("menu with no options");
  return [first, ...rest];
}

/** Fonts offered, keyed to NERD_FONTS in wsl.ts. */
const FONT_LABELS: Record<string, string> = {
  firacode: "FiraCode — ligatures, the default",
  jetbrainsmono: "JetBrains Mono — taller x-height",
  hack: "Hack — no ligatures",
  caskaydiacove: "Caskaydia Cove — Microsoft's Cascadia",
};

type Handlers = {
  install: () => Promise<number>;
  update: () => Promise<number>;
  doctor: () => Promise<number>;
  plan: () => Promise<number>;
  platform: () => number;
  apps: () => Promise<number>;
  lang: () => Promise<number>;
  shell: () => Promise<number>;
  uninstall: () => Promise<number>;
  applyTheme: (name: string) => Promise<number>;
  applyFont: (font: string, size: number) => Promise<void>;
};

async function themeMenu(p: Platform, h: Handlers): Promise<void> {
  const prefs = await readPreferences(p);
  const current = prefs.theme ?? "tokyo-night";

  for (;;) {
    const choices = options(...themeNames(), BACK);
    const picked = await select(`Theme? (current: ${current})`, choices, current);
    if (picked === BACK) return;
    if (!THEMES[picked]) {
      log.err(`unknown theme '${picked}'`);
      continue;
    }
    await h.applyTheme(picked);
    await writePreferences(p, { theme: picked });
    return;
  }
}

async function fontMenu(p: Platform, h: Handlers): Promise<void> {
  for (;;) {
    const prefs = await readPreferences(p);
    const font = prefs.font ?? "firacode";
    const size = prefs.fontSize ?? 11;

    const picked = await select(
      "Font",
      [`Family — ${font}`, `Size — ${size}pt`, BACK] as const,
      `Family — ${font}`,
    );
    if (picked === BACK) return;

    if (picked.startsWith("Family")) {
      const labels = Object.entries(FONT_LABELS).map(([k, v]) => `${k} — ${v}`);
      const chosen = await select(
        "Which font?",
        options(...labels, BACK),
        labels.find((l) => l.startsWith(font)) ?? labels[0]!,
      );
      if (chosen === BACK) continue;
      const key = chosen.split(" ")[0]!;
      await writePreferences(p, { font: key });
      await h.applyFont(key, size);
      log.ok(`font: ${key} — open a new terminal to see it`);
      continue;
    }

    // omakub offers 7 through 14; the same range, bounded so a typo
    // cannot produce an unreadable terminal.
    const chosen = await number("Size in points?", size, { min: 7, max: 14 });
    await writePreferences(p, { fontSize: chosen });
    await h.applyFont(font, chosen);
    log.ok(`font size: ${chosen}pt — open a new terminal to see it`);
  }
}

export async function runMenu(
  p: Platform,
  inv: Invocation,
  help: string,
  h: Handlers,
): Promise<number> {
  if (!process.stdin.isTTY) {
    log.plain(help);
    return 0;
  }

  log.plain(banner(summary(p).split("\n")[0] ?? ""));
  let last = 0;

  for (;;) {
    const wslish = p.env === "wsl" || p.os === "windows";
    const entries = [
      "Install — converge this machine",
      "Theme — colour scheme",
      "Font — family and size",
      "Apps — optional tools",
      "Languages — runtimes mise manages",
      ...(wslish ? ["Shell — where a terminal lands"] : []),
      "Update — upgrade, then converge",
      "Plan — preview, change nothing",
      "Doctor — report drift",
      "Uninstall — remove tools or config",
      "Platform — what this machine is",
      "Quit",
    ] as [string, ...string[]];

    const picked = await select("What now?", entries, entries[0]);
    const verb = picked.split(" ")[0];

    switch (verb) {
      case "Install":
        last = await h.install();
        break;
      case "Theme":
        await themeMenu(p, h);
        break;
      case "Font":
        await fontMenu(p, h);
        break;
      case "Apps":
        last = await h.apps();
        break;
      case "Languages":
        last = await h.lang();
        break;
      case "Shell":
        last = await h.shell();
        break;
      case "Update":
        last = await h.update();
        break;
      case "Plan":
        last = await h.plan();
        break;
      case "Doctor":
        last = await h.doctor();
        break;
      case "Uninstall":
        last = await h.uninstall();
        break;
      case "Platform":
        last = h.platform();
        break;
      default:
        return last;
    }

    // Returning to the menu rather than exiting is the whole point:
    // changing a theme and then a font used to mean running the tool
    // twice.
    log.plain("");
    void inv;
  }
}
