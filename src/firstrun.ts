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
import type { SetupAnswers } from "./tui-setup-model.ts";
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

/**
 * The interview's questions, built once and handed to the interface.
 *
 * Split out because the fullscreen menu hosts the interview itself now.
 * It used to live only inside `red-dev install`, behind a first-run gate
 * and a no-scope gate — and the menu is the path the one-liner takes, so
 * choosing Install converged the whole manifest having asked nothing.
 */
export async function buildSetupSteps(p: Platform) {
  const { setupSteps } = await import("./tui-setup-model.ts");
  const { availableAgents, isAgentInstalled } = await import("./agents.ts");
  const { toolsInScope, providerFor } = await import("./manifest.ts");
  const { OFFERED_RUNTIMES } = await import("./runtimes.ts");

  return setupSteps(
    p,
    availableAgents(p).map((a) => ({
      key: a.key,
      label: a.label,
      note: isAgentInstalled(a) ? `${a.about} — installed` : a.about,
    })),
    toolsInScope("optional")
      .filter((t) => providerFor(t, p).kind !== "skip")
      .map((t) => ({ key: t.name, label: t.name, note: t.about ?? "", off: t.offByDefault })),
    OFFERED_RUNTIMES.map((r) => ({ key: r.id, label: r.id, note: r.about })),
  );
}

/**
 * Carry out what the interview decided, before the converge starts.
 *
 * The same body askFirstRun runs after its own wizard, reachable from
 * the fullscreen menu — which is where the questions were missing.
 */
export async function applySetupAnswers(
  p: Platform,
  inv: { scope?: string | undefined },
  answers: SetupAnswers,
): Promise<{ answers: SetupAnswers }> {
  if (answers.share) {
    const { chooseSharedRoot } = await import("./shared-root.ts");
    try {
      await chooseSharedRoot(p);
    } catch (err) {
      log.warn(`shared root: ${(err as Error).message}`);
    }
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
  await writeShellEnv(p, answers.blesh);
  await carryOutChoices(p, {
    agents: answers.agents,
    runtimes: answers.runtimes,
    apps: answers.apps,
  });
  void inv;
  return { answers };
}

/**
 * Install what the interview chose.
 *
 * This lived inside cmdInstall's first-run branch and nowhere else, so
 * the fullscreen menu — the path the one-liner takes — asked which
 * agents you wanted and then installed none of them. You picked
 * claude-code, codex and opencode, the interview closed, the converge
 * ran, and nothing had happened.
 *
 * red-skills runs once at the end rather than per agent, because its
 * installer detects which hosts are present and wires each one. Running
 * it first would find nothing and report success — the same ordering
 * mistake as the tool itself warns about.
 */
export async function carryOutChoices(
  p: Platform,
  choices: { agents?: string[]; runtimes: string[]; apps: string[] },
): Promise<void> {
  const agents = choices.agents ?? [];
  if (agents.length > 0) {
    const { availableAgents, installAgent, isAgentInstalled, installRedSkills } = await import(
      "./agents.ts"
    );
    const available = availableAgents(p);
    for (const key of agents) {
      const agent = available.find((a) => a.key === key);
      if (!agent) continue;
      if (isAgentInstalled(agent)) {
        log.skip(`${agent.label} already present`);
        continue;
      }
      try {
        await installAgent(agent, p);
        log.ok(agent.label);
      } catch (err) {
        // One agent failing never stops the others, the same policy the
        // converge has for tools.
        log.err(`${agent.label}: ${(err as Error).message}`);
      }
    }
    // The desktop apps host no skills, so picking only those is not a
    // reason to run the installer.
    if (agents.some((k) => k !== "claude-desktop" && k !== "codex-desktop" && k !== "t3code")) {
      try {
        await installRedSkills();
      } catch (err) {
        log.warn(`red-skills: ${(err as Error).message}`);
      }
    }
  }

  if (choices.runtimes.length > 0) {
    const { useRuntimes } = await import("./runtimes.ts");
    try {
      await useRuntimes(choices.runtimes);
    } catch (err) {
      log.warn(`runtimes: ${(err as Error).message}`);
    }
  }
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
        .map((t) => ({ key: t.name, label: t.name, note: t.about ?? "", off: t.offByDefault })),
      OFFERED_RUNTIMES.map((r) => ({ key: r.id, label: r.id, note: r.about })),
    );

    if (!answers) {
      // Left early: no answers recorded, so the next run asks again
      // rather than silently keeping half a set.
      log.skip("setup skipped — run `red-dev` when you want to choose");
      return null;
    }

    // Established before the converge writes anything, which is the
    // whole point of asking it first: configuration should be born in
    // the share rather than written locally and migrated afterwards.
    if (answers.share) {
      const { chooseSharedRoot } = await import("./shared-root.ts");
      try {
        await chooseSharedRoot(p);
      } catch (err) {
        // Never fatal. A first run that cannot reach the Windows side is
        // a first run that should still finish.
        log.warn(`shared root: ${(err as Error).message}`);
      }
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

  // 4. Extra tools, all of them ticked.
  //
  // This used to default to none and call empty a good answer. That is
  // true for a list you have to evaluate and wrong for a curated one —
  // the point of an omakase setup is that somebody already chose, and
  // none of these is installed by a plain converge, so this list is the
  // only thing that decides.
  const { toolsInScope, providerFor } = await import("./manifest.ts");
  const optional = toolsInScope("optional").filter((t) => providerFor(t, p).kind !== "skip");
  const appLabels = optional.map((t) => `${t.name} — ${t.about ?? ""}`);
  // Ticked, minus whatever the manifest says is too large to be a
  // default. Same rule the fullscreen interview follows, read from the
  // same place rather than repeated as a list of names.
  const appDefaults = optional
    .filter((t) => !t.offByDefault)
    .map((t) => `${t.name} — ${t.about ?? ""}`);
  const pickedApps =
    appLabels.length > 0
      ? await checkbox(
          "Optional tools? (space to untick what you do not want)",
          appLabels as [string, ...string[]],
          appDefaults,
        )
      : [];

  // 5. Plugins — things that attach to bash rather than sit beside it.
  //    ble.sh is the only one, and the only question here with a real
  //    caveat, so it gets stated before the question rather than after.
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
  await recordShellEnv({ RED_BLE: blesh ? "1" : "0" });
  void p;
}

/**
 * Record one or more choices, keeping the ones already there.
 *
 * Merged rather than rewritten, and that is the whole reason this exists
 * separately. The first version of this file was generated wholesale
 * from a single answer, so the moment a second setting needed recording
 * — the shared root — writing it would have silently dropped RED_BLE.
 * An answer a later write discards is not a recorded answer.
 */
export async function recordShellEnv(vars: Record<string, string>): Promise<void> {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!home) return;

  const dir = `${home}/.config/red-dev`;
  const { mkdirSync, existsSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/env.sh`;

  const existing = new Map<string, string>();
  if (existsSync(path)) {
    for (const line of (await Bun.file(path).text()).split("\n")) {
      const m = /^export\s+([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m?.[1]) existing.set(m[1], m[2] ?? "");
    }
  }
  // Quoted, because a Windows path is full of backslashes and one of
  // them in front of the wrong character is a different string.
  for (const [k, v] of Object.entries(vars)) existing.set(k, `'${v.replace(/'/g, "'\\''")}'`);

  const body =
    `# Generated by red-dev. Sourced by config/bash/rc.sh.\n` +
    `# Edit through red-dev's own commands or by hand; it is only shell.\n` +
    [...existing].map(([k, v]) => `export ${k}=${v}`).join("\n") +
    "\n";
  await Bun.write(path, body);
}
