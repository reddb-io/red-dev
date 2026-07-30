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
  /** Agent keys chosen, when the fullscreen setup ran. */
  agents?: string[];
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

  // Fullscreen when the terminal will take it, which is what was asked
  // for: the theme step previews the palette while the cursor moves, and
  // a linear prompt cannot. The prompt sequence below stays as the
  // fallback for terminals too small to lay out two columns and for
  // anything that reports no size at all.
  const columns = process.stdout.columns ?? 0;
  if (columns >= 60) {
    const { runSetupTui } = await import("./tui-setup.ts");
    const { availableAgents, isAgentInstalled } = await import("./agents.ts");
    const { toolsInScope, providerFor } = await import("./manifest.ts");
    const { OFFERED_RUNTIMES } = await import("./runtimes.ts");

    const answers = await runSetupTui(
      p,
      availableAgents(p).map((a) => ({
        key: a.key,
        label: a.label,
        note: isAgentInstalled(a) ? `${a.about} — installed` : a.about,
      })),
      toolsInScope("optional")
        .filter((t) => providerFor(t, p).kind !== "skip")
        .map((t) => ({ key: t.name, label: t.name, note: t.about ?? "" })),
      OFFERED_RUNTIMES.map((r) => ({ key: r.id, label: r.id, note: r.about })),
    );

    if (!answers) {
      // Left early: no answers recorded, so the next run asks again
      // rather than silently keeping half a set.
      log.skip("setup skipped — run `red-dev` when you want to choose");
      return null;
    }

    await writePreferences(p, {
      setupCompleted: true,
      theme: answers.theme,
      font: answers.font,
      blesh: answers.blesh,
      ...(answers.terminalShell ? { terminalShell: answers.terminalShell } : {}),
      ...(answers.terminalShell === "wsl" && process.env["WSL_DISTRO_NAME"]
        ? { distro: process.env["WSL_DISTRO_NAME"] }
        : {}),
    });

    return {
      theme: answers.theme,
      font: answers.font,
      apps: answers.apps,
      runtimes: answers.runtimes,
      agents: answers.agents,
      blesh: answers.blesh,
    };
  }

  log.plain("");
  log.step("First run on this machine — a few choices, then it stays quiet.");
  log.plain("     Every one of these is changeable later; nothing here is final.");
  log.plain("");

  // ---------------------------------------------------------------
  // Order: structural first, cosmetic last.
  //
  // This asked the colour scheme first and whether the machine gets a
  // Linux side at all near the end, which is exactly backwards. On a
  // fresh Windows the WSL answer changes what every later question even
  // means — which shell the terminal opens, where the tools land — and
  // a palette changes nothing. Anyone can abandon the sequence after
  // the decisions that matter and lose only the paint.
  // ---------------------------------------------------------------

  // 1. Does this machine get a Linux side? Nothing else reframes the
  //    rest of the run the way this does.
  if (p.os === "windows") {
    const { offerWsl } = await import("./wsl-provision.ts");
    await offerWsl(p);
  }

  // 2. Where a terminal lands, now that we know whether both sides
  //    exist.
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

  // 3. What you build with.
  const { OFFERED_RUNTIMES } = await import("./runtimes.ts");
  const runtimeLabels = OFFERED_RUNTIMES.map((r) => `${r.id} — ${r.about}`);
  const pickedRuntimes = await checkbox(
    "Language runtimes for mise to manage?",
    runtimeLabels as [string, ...string[]],
    [runtimeLabels[0]!],
  );

  // 4. Extra tools. Empty is a perfectly good answer and the default.
  const { toolsInScope, providerFor } = await import("./manifest.ts");
  const optional = toolsInScope("optional").filter((t) => providerFor(t, p).kind !== "skip");
  const appLabels = optional.map((t) => `${t.name} — ${t.about ?? ""}`);
  const pickedApps =
    appLabels.length > 0
      ? await checkbox("Optional tools? (space to select, enter for none)", appLabels as [string, ...string[]], [])
      : [];

  // 5. The one question with a real caveat, so it gets stated before
  //    the question rather than after.
  log.plain("");
  log.plain("     ble.sh adds autosuggestions and syntax highlighting to bash.");
  log.plain("     It replaces the line editor that atuin, fzf and carapace bind");
  log.plain("     into, so it is off by default until you confirm Ctrl-R still");
  log.plain("     reaches atuin.");
  const blesh = await confirm("Enable ble.sh?", false);

  // 6. Paint. Last, because it is the only thing here that changes
  //    nothing but how it looks — and `red-dev theme` previews these
  //    live, which this linear prompt cannot.
  const font = (await select("Terminal font?", FONTS, FONTS[0])).split(" ")[0]!;
  const theme = await select(
    "Colour scheme?  (red-dev ui previews these)",
    themeNames() as [string, ...string[]],
    "tokyo-night",
  );

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
