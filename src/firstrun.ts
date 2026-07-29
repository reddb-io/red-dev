/**
 * The questions omakub asks on a first run.
 *
 * `install` used to ask nothing at all, justified as "it has to work in
 * CI". Half of that is true — a prompt with nobody to answer it is a
 * hang, and this tool runs in pipelines and over SSH. The other half was
 * an excuse: every primitive in ui.ts already returns its fallback when
 * there is no TTY, so asking costs nothing where nobody can answer.
 *
 * So the rule is narrower than "never ask": ask once, on a real
 * terminal, when this machine has not been set up before. After that
 * the answers are recorded and the same command is silent, which is
 * what makes it safe to re-run from a script.
 */

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, writePreferences, type Preferences } from "./preferences.ts";
import { themeNames } from "./themes.ts";
import { checkbox, confirm, interactive, select } from "./ui.ts";

export interface FirstRunChoices {
  theme?: string;
  font?: string;
  /** Names of optional tools to install alongside core. */
  apps: string[];
  /** mise runtime ids. */
  runtimes: string[];
  blesh: boolean;
}

const FONTS = [
  "firacode — the default; ligatures",
  "jetbrainsmono — taller x-height",
  "hack — no ligatures",
  "caskaydiacove — Microsoft's Cascadia",
] as const;

/**
 * Has this machine been set up before?
 *
 * Keyed on a recorded answer rather than on installed tools: someone
 * who ran `install` non-interactively should still get the questions the
 * first time they run it from a terminal.
 */
export async function isFirstRun(p: Platform): Promise<boolean> {
  const prefs = await readPreferences(p);
  return prefs.setupCompleted !== true;
}

export async function askFirstRun(p: Platform): Promise<FirstRunChoices | null> {
  if (!interactive()) return null;

  log.plain("");
  log.step("First run on this machine — a few choices, then it stays quiet.");
  log.plain("     Every one of these is changeable later; nothing here is final.");
  log.plain("");

  const theme = await select(
    "Colour scheme?",
    themeNames() as [string, ...string[]],
    "tokyo-night",
  );

  const fontLabel = await select("Terminal font?", FONTS, FONTS[0]);
  const font = fontLabel.split(" ")[0]!;

  // Optional tools, offered by name and one-line purpose. Empty is a
  // perfectly good answer and the default.
  const { toolsInScope, providerFor } = await import("./manifest.ts");
  const optional = toolsInScope("optional").filter((t) => providerFor(t, p).kind !== "skip");
  const appLabels = optional.map((t) => `${t.name} — ${t.about ?? ""}`);
  const pickedApps =
    appLabels.length > 0
      ? await checkbox("Optional tools? (space to select, enter for none)", appLabels as [string, ...string[]], [])
      : [];

  const { OFFERED_RUNTIMES } = await import("./runtimes.ts");
  const runtimeLabels = OFFERED_RUNTIMES.map((r) => `${r.id} — ${r.about}`);
  const pickedRuntimes = await checkbox(
    "Language runtimes for mise to manage?",
    runtimeLabels as [string, ...string[]],
    [],
  );

  // A boolean, and the one question with a real caveat attached.
  log.plain("");
  log.plain("     ble.sh adds autosuggestions and syntax highlighting to bash.");
  log.plain("     It replaces the line editor that atuin, fzf and carapace bind");
  log.plain("     into, so it is off by default until you confirm Ctrl-R still");
  log.plain("     reaches atuin.");
  const blesh = await confirm("Enable ble.sh?", false);

  // The Windows/WSL question, asked only where both sides exist.
  let terminalShell: Preferences["terminalShell"];
  if (p.env === "wsl" || p.os === "windows") {
    const distro = process.env["WSL_DISTRO_NAME"] ?? "your WSL distro";
    const picked = await select(
      "When you open a terminal, where should it land?",
      [`wsl — ${distro}, in its own filesystem`, "gitbash — stay on Windows, same dotfiles"] as const,
      `wsl — ${distro}, in its own filesystem`,
    );
    terminalShell = picked.startsWith("wsl") ? "wsl" : "gitbash";
  }

  const choices: FirstRunChoices = {
    theme,
    font,
    apps: pickedApps.map((l) => l.split(" ")[0]!),
    runtimes: pickedRuntimes.map((l) => l.split(" ")[0]!),
    blesh,
  };

  await writePreferences(p, {
    setupCompleted: true,
    theme,
    font,
    blesh,
    ...(terminalShell ? { terminalShell } : {}),
    ...(terminalShell === "wsl" && process.env["WSL_DISTRO_NAME"]
      ? { distro: process.env["WSL_DISTRO_NAME"] }
      : {}),
  });

  log.plain("");
  return choices;
}

/**
 * Persist RED_BLE for the shell.
 *
 * rc.sh reads an env file rather than a preference, because a shell
 * cannot parse JSON without help and this has to work before any of the
 * installed tools are on PATH.
 */
export async function writeShellEnv(p: Platform, blesh: boolean): Promise<void> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) return;

  const dir = `${home}/.config/red-dev`;
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });

  const body = `# Generated by red-dev. Sourced by config/bash/rc.sh.
# Edit through \`red-dev install\` or by hand; it is only shell.
export RED_BLE=${blesh ? "1" : "0"}
`;
  await Bun.write(`${dir}/env.sh`, body);
  void p;
}
