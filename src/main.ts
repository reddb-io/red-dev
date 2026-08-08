#!/usr/bin/env bun
/**
 * red-dev — one dev environment across Ubuntu 24, Ubuntu 26, WSL and Windows.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { buildCli, parseArgs, VERSION, type Invocation } from "./cli.ts";
import type { StepOutcome } from "./converge.ts";
import { log } from "./log.ts";
import {
  applicableScopes,
  describeProvider,
  installedVersion,
  installState,
  isInstalled,
  providerFor,
  toolsInScope,
  type Scope,
} from "./manifest.ts";
import { detect, summary, type Platform } from "./platform.ts";
import { administratorNotice } from "./plan.ts";
import { applyProvider, systemUpdate, type ApplyContext } from "./providers.ts";
import { applyContextForEntry, type ApplyContextEntryPath } from "./preferences.ts";
import { themeFor, themeNames } from "./themes.ts";
import { interactive, select } from "./ui.ts";

function resolveScopes(p: Platform, arg?: string): Scope[] {
  return arg ? [arg as Scope] : applicableScopes(p);
}

async function contextFor(
  p: Platform,
  inv: Invocation,
  entry: ApplyContextEntryPath,
): Promise<ApplyContext> {
  return await applyContextForEntry(p, inv, entry);
}

function cmdPlatform(p: Platform): number {
  log.plain(summary(p));
  return 0;
}

async function cmdPlan(p: Platform, inv: Invocation): Promise<number> {
  await contextFor(p, inv, "plan");
  const scopes = resolveScopes(p, inv.scope);
  for (const scope of scopes) {
    log.plain(`\n[${scope}]`);
    for (const tool of toolsInScope(scope)) {
      const pr = providerFor(tool, p);
      // A skipped tool is not also "managed": the skip already says the
      // provider will not run, and printing both reads as a
      // contradiction.
      const state =
        pr.kind === "skip"
          ? ""
          : tool.managed
            ? " (managed)"
            : isInstalled(tool)
              ? " (present)"
              : installState(tool) === "outdated"
                ? ` (outdated, wants ${tool.minVersion})`
                : "";
      log.plain(`  ${tool.name.padEnd(17)}${describeProvider(pr)}${state}`);
    }
  }
  // Last, where a summary belongs: the rows it names have just been
  // read, and it is the line the operator acts on — this plan is still
  // free to abandon in favour of an elevated session, which is the whole
  // reason for saying it here rather than at the item that needs the
  // rights.
  for (const line of administratorNotice(p, scopes)) log.plain(line);
  return 0;
}

async function cmdDoctor(p: Platform, inv: Invocation): Promise<number> {
  let missing = 0;
  let outdated = 0;

  // Which of the two this machine currently is.
  //
  // Everything below is answered per-target, and reading a report
  // without knowing which target it describes is how "the theme did not
  // apply" turns into an hour of looking at the wrong side.
  if (p.os === "windows" || p.env === "wsl") {
    log.plain("\n[mode]");
    const { resolveTerminalShell, readPreferences } = await import("./preferences.ts");
    const prefs = await readPreferences(p);
    const mode = await resolveTerminalShell(p);
    const where = mode === "wsl" ? (prefs.distro ?? "WSL") : "Git Bash";
    // A recorded choice and an inferred one look identical afterwards,
    // and only one of them is an answer.
    const how = prefs.terminalShell ? "recorded" : "defaulted, never chosen";
    log.ok(`a new terminal opens into ${where} — ${how}`);
    log.plain("       change it with: red-dev shell");
  }

  log.plain("\n[tools]");
  for (const scope of resolveScopes(p, inv.scope)) {
    for (const tool of toolsInScope(scope)) {
      const pr = providerFor(tool, p);
      if (pr.kind === "skip") {
        log.skip(`${tool.name} — ${pr.reason}`);
      } else if (tool.managed) {
        // Not a binary on PATH; the configuration section below is what
        // actually answers whether these did their job.
        continue;
      } else if (isInstalled(tool)) {
        log.ok(tool.name);
      } else if (installState(tool) === "outdated") {
        // Named apart from missing because the fix is different: an
        // absent tool needs installing, this one needs a source that
        // carries something newer. Reporting it as missing sent someone
        // looking for a binary that was sitting on PATH the whole time.
        const found = installedVersion(tool) ?? "unknown";
        log.err(`${tool.name} ${found} — older than ${tool.minVersion} (${describeProvider(pr)})`);
        outdated++;
      } else {
        log.err(`${tool.name} missing (${describeProvider(pr)})`);
        missing++;
      }
    }
  }

  // Presence on PATH is the easy half. Everything that goes wrong after
  // a successful install is configuration, and it is silent.
  log.plain("\n[configuration]");
  const { collectDrift } = await import("./drift.ts");
  const checks = await collectDrift(p);
  let drifted = 0;

  for (const c of checks) {
    if (c.status === "ok") {
      log.ok(`${c.name} — ${c.detail}`);
    } else if (c.status === "n/a") {
      log.skip(`${c.name} — ${c.detail}`);
    } else {
      log.err(`${c.name} — ${c.detail}`);
      if (c.fix) log.plain(`       fix: ${c.fix}`);
      drifted++;
    }
  }

  log.plain("");
  if (missing > 0 || outdated > 0 || drifted > 0) {
    const parts = [`${missing} tool(s) missing`];
    if (outdated > 0) parts.push(`${outdated} outdated`);
    parts.push(`${drifted} config drift(s)`);
    log.warn(parts.join(", "));
    return 1;
  }
  log.ok("no drift");
  return 0;
}

async function cmdInstall(
  p: Platform,
  inv: Invocation,
  entry: "install" | "update" = "install",
): Promise<number> {
  let ctx = await contextFor(p, inv, entry);
  let extraScopes: Scope[] = [];

  // Ask once, on a real terminal, when this machine is new. Every ui.ts
  // primitive returns its fallback without a TTY, so this is inert in
  // CI, in a pipe and over a non-interactive SSH — which is what makes
  // asking safe rather than something to avoid entirely.
  if (!inv.dryRun && !inv.yes && !inv.scope) {
    const { isFirstRun, askFirstRun, writeShellEnv, carryOutChoices } = await import("./firstrun.ts");
    if (await isFirstRun(p)) {
      const choices = await askFirstRun(p);
      if (choices) {
        // The answers override the flag defaults for this run.
        ctx = {
          ...ctx,
          theme: choices.theme ?? ctx.theme,
          font: choices.font ?? ctx.font,
        };
        inv = { ...inv, themeName: choices.theme ?? inv.themeName, font: choices.font ?? inv.font };
        if (choices.apps.length > 0) extraScopes = ["optional"];
        await writeShellEnv(p, choices.blesh);

        // One implementation, reachable from both paths. It used to live
        // only here, so the fullscreen menu asked which agents you wanted
        // and installed none of them.
        await carryOutChoices(p, choices);
      }
    }
  }

  // Repairs before converging: a machine can be broken in a way that
  // looks complete, and then converging finds nothing to do.
  if (!inv.dryRun) {
    const { runPendingMigrations } = await import("./migrations.ts");
    await runPendingMigrations(p);
  }

  const scopes = [...resolveScopes(p, inv.scope), ...extraScopes];

  // Fullscreen when there is a terminal wide enough for it: the live
  // view is the default experience, and the line report is what runs in
  // CI, in a pipe, over a dumb SSH session and on a narrow window.
  if (!inv.dryRun && interactive() && (process.stdout.columns ?? 0) >= 60) {
    const { runInstallTui } = await import("./tui-install.ts");
    const { failed } = await runInstallTui({ platform: p, ctx, scopes });
    if (failed > 0) return 1;
    log.ok("converged — restart your shell");
    return 0;
  }

  log.step(summary(p).split("\n")[0] ?? "");

  const { Reporter } = await import("./report.ts");
  const { converge } = await import("./converge.ts");
  const report = new Reporter();

  // The loop lives in converge.ts and emits events; this turns each one
  // into a line. The fullscreen view subscribes to the same events and
  // draws them instead — one ordering, one apt batch, one failure
  // policy, two presentations.
  let close: ((outcome: StepOutcome, detail?: string) => void) | null = null;
  const { failed } = await converge(
    { platform: p, ctx, scopes: scopes, dryRun: inv.dryRun },
    {
      scopeStart: (scope, total) => report.scope(scope, total),
      note: (message) => report.note(message),
      stepStart: (e) => {
        close = report.begin(e.tool, e.provider || "—");
      },
      stepEnd: (r) => {
        close?.(r.outcome, r.detail);
        close = null;
      },
    },
  );

  report.finish();

  if (inv.dryRun) {
    log.ok("dry run — nothing changed");
    return 0;
  }
  if (failed > 0) return 1;
  log.ok("converged — restart your shell");
  return 0;
}

async function cmdUpdate(p: Platform, inv: Invocation): Promise<number> {
  try {
    await systemUpdate(p);
  } catch (err) {
    log.err((err as Error).message);
    return 1;
  }
  // Before the converge, because the converge builds out of this tree:
  // convergeRedSkills stops at "already wired", which is correct for
  // install and leaves the checkout frozen forever under update.
  if (!inv.dryRun) {
    try {
      const { updateRedSkills } = await import("./agents.ts");
      await updateRedSkills(p);
    } catch (err) {
      // Never fatal: the rest of the machine still has an update to do.
      log.warn(`red-skills: ${(err as Error).message}`);
    }
  }

  // Upgrading can leave the manifest unsatisfied (a package removed, a
  // binary replaced), so always re-converge afterwards.
  return await cmdInstall(p, inv, "update");
}

async function cmdTheme(p: Platform, inv: Invocation, name?: string): Promise<number> {
  const ctx = await contextFor(p, inv, "theme");
  const chosen =
    name ?? (await select("Theme?", themeNames() as [string, ...string[]], ctx.theme));
  const theme = themeFor(chosen);
  if (!theme) {
    log.err(`unknown theme '${chosen}' (known: ${themeNames().join(", ")})`);
    return 1;
  }

  const wsl = await import("./wsl.ts");
  const spec = wsl.NERD_FONTS[ctx.font];
  if (!spec) {
    log.err(`unknown font '${ctx.font}'`);
    return 1;
  }

  let failures = 0;

  // Alacritty is the terminal on every target, so this is the branch
  // that always runs. Windows Terminal is configured too where it
  // exists, because plenty of people keep using it.
  try {
    const { configureAlacritty } = await import("./alacritty.ts");
    await configureAlacritty({
      platform: p,
      fontFamily: spec.family,
      fontSize: ctx.fontSize,
      opacity: ctx.opacity,
    });
  } catch (err) {
    log.err(`alacritty: ${(err as Error).message}`);
    failures++;
  }

  // The terminal, which a theme does not touch. Reasserted here anyway,
  // because `red-dev theme` is the command people reach for when colours
  // look wrong — and on a machine carrying an old palette, this is the
  // run that removes it.
  try {
    const { applyTerminalDefaults } = await import("./terminal-surfaces.ts");
    const { deferred, cleared } = await applyTerminalDefaults(p);
    if (cleared.length > 0) log.ok(`colours handed back: ${cleared.join(", ")}`);
    if (deferred.length > 0) log.skip(`following your terminal: ${deferred.join(", ")}`);
  } catch (err) {
    log.warn(`terminal defaults: ${(err as Error).message}`);
  }

  // The desktop, which does.
  try {
    const { applyThemeEverywhere } = await import("./theme-apply.ts");
    const { applied, skipped } = await applyThemeEverywhere(chosen, p);
    if (applied.length > 0) log.ok(`themed: ${applied.join(", ")}`);
    if (skipped.length > 0) log.skip(`not present: ${skipped.join(", ")}`);
  } catch (err) {
    log.warn(`theme surfaces: ${(err as Error).message}`);
  }

  if (p.env === "wsl" || p.os === "windows") {
    try {
      await wsl.configureWindowsTerminal({
        fontFace: spec.family,
        opacity: ctx.opacity,
        distro: process.env["WSL_DISTRO_NAME"] ?? undefined,
        home: process.env["HOME"] ?? undefined,
      });
    } catch (err) {
      log.warn(`windows terminal: ${(err as Error).message}`);
    }
  }

  if (failures > 0) return 1;
  log.ok(`theme: ${theme.name} — open a new terminal to see it`);
  return 0;
}

/**
 * Choose optional tools.
 *
 * `install` stays silent on purpose — it runs in CI and in scripts,
 * where a prompt is a hang. Everything that wants an answer lives
 * behind a command you invoke deliberately, which is also why this can
 * be re-run whenever the answer changes.
 */
async function cmdApps(p: Platform, inv: Invocation): Promise<number> {
  const { checkbox } = await import("./ui.ts");
  const available = toolsInScope("optional").filter(
    (t) => providerFor(t, p).kind !== "skip",
  );

  if (available.length === 0) {
    log.skip("no optional tools apply to this target");
    return 0;
  }

  const already = available.filter(isInstalled).map((t) => t.name);
  const labels = available.map((t) =>
    `${t.name}${t.about ? ` — ${t.about}` : ""}${already.includes(t.name) ? "  (installed)" : ""}`,
  );

  const picked = await checkbox("Which optional tools?", labels as [string, ...string[]], []);
  if (picked.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  // Map the decorated labels back to tool names.
  const names = picked.map((l) => l.split(" ")[0]!.trim());
  const ctx = await contextFor(p, inv, "install");
  let failures = 0;

  for (const name of names) {
    const tool = available.find((t) => t.name === name);
    if (!tool) continue;
    if (isInstalled(tool)) {
      log.skip(`${name} already present`);
      continue;
    }
    try {
      await applyProvider(providerFor(tool, p), ctx);
      log.ok(name);
    } catch (err) {
      log.err(`${name}: ${(err as Error).message}`);
      failures++;
    }
  }

  return failures > 0 ? 1 : 0;
}

/**
 * Choose where a terminal lands on a machine that has both Windows and
 * WSL.
 *
 * Windows Terminal already has profiles for this and red-dev already
 * sets its default. Alacritty has none — one config, one shell — so the
 * choice has to be recorded somewhere both sides can read, which is
 * what src/preferences.ts is for.
 */
async function cmdShell(p: Platform, inv: Invocation): Promise<number> {
  if (p.os !== "windows" && p.env !== "wsl") {
    log.skip("only Windows and WSL have two sides to choose between");
    return 0;
  }

  const { select } = await import("./ui.ts");
  const { readPreferences, writePreferences } = await import("./preferences.ts");
  const current = await readPreferences(p);

  const distro = current.distro ?? process.env["WSL_DISTRO_NAME"] ?? "Ubuntu-24.04";
  const OPTIONS = [
    `wsl — open ${distro}, in its own filesystem`,
    "gitbash — stay on Windows, same dotfiles",
  ] as const;

  const picked = await select(
    "When you open a terminal, where should it land?",
    OPTIONS,
    OPTIONS[0],
  );
  const choice = picked.startsWith("wsl") ? "wsl" : "gitbash";

  await writePreferences(p, {
    terminalShell: choice,
    // Record the distro too: on native Windows there is no
    // WSL_DISTRO_NAME to fall back on later.
    ...(choice === "wsl" ? { distro } : {}),
  });
  log.ok(`terminal will open: ${choice === "wsl" ? distro : "Git Bash"}`);

  // Rewrite the Alacritty config so the choice takes effect now rather
  // than at the next converge.
  try {
    const { configureAlacritty } = await import("./alacritty.ts");
    const wsl = await import("./wsl.ts");
    const ctx = await contextFor(p, inv, "theme");
    const theme = themeFor(ctx.theme);
    const spec = wsl.NERD_FONTS[ctx.font];
    if (theme && spec) {
      await configureAlacritty({
        platform: p,
        fontFamily: spec.family,
        fontSize: ctx.fontSize,
        opacity: ctx.opacity,
      });
    }
    log.plain("     open a new terminal window to see it");
  } catch (err) {
    log.warn(`alacritty: ${(err as Error).message}`);
  }

  if (p.os === "windows" && choice === "wsl") {
    const { syncSelectedTooling } = await import("./wsl-sync.ts");
    return (await syncSelectedTooling(p)) > 0 ? 1 : 0;
  }
  return 0;
}

/**
 * Remove things. The only destructive command here, so it names what
 * will go and waits for a yes before doing any of it.
 */
async function cmdUninstall(p: Platform): Promise<number> {
  const { checkbox, confirm, select } = await import("./ui.ts");
  const { removableTools, removeConfiguration } = await import("./uninstall.ts");

  const what = await select(
    "Remove what?",
    ["Tools — pick from what is installed", "red-dev's own configuration", "Cancel"] as const,
    "Cancel",
  );
  if (what === "Cancel") return 0;

  if (what.startsWith("red-dev")) {
    log.warn("This removes the shipped dotfiles, the ~/.bashrc hook and recorded preferences.");
    log.plain("     Installed tools stay. Your pre-red-dev shell backup stays.");
    if (!(await confirm("Remove red-dev's configuration?", false))) {
      log.skip("nothing removed");
      return 0;
    }
    const removed = await removeConfiguration();
    for (const r of removed) log.ok(`removed ${r}`);
    return 0;
  }

  const candidates = removableTools(p);
  if (candidates.length === 0) {
    log.skip("nothing removable found");
    return 0;
  }

  const labels = candidates.map((c) => `${c.tool.name} — ${c.removal.how}`);
  const picked = await checkbox("Which tools?", labels as [string, ...string[]], []);
  if (picked.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  const names = picked.map((l) => l.split(" ")[0]!);
  log.plain("");
  log.warn(`About to remove: ${names.join(", ")}`);
  if (!(await confirm("Go ahead?", false))) {
    log.skip("nothing removed");
    return 0;
  }

  let failures = 0;
  for (const name of names) {
    const found = candidates.find((c) => c.tool.name === name);
    if (!found) continue;
    try {
      await found.removal.run();
      log.ok(`removed ${name}`);
    } catch (err) {
      log.err(`${name}: ${(err as Error).message}`);
      failures++;
    }
  }
  return failures > 0 ? 1 : 0;
}

/**
 * The fullscreen interface.
 *
 * Hands back an action rather than doing the work itself: the TUI owns
 * the screen while it runs, and a converge printing thirty lines
 * underneath a live layout would fight it for the terminal. It exits
 * first, then the chosen command runs normally.
 */
async function cmdUi(p: Platform, inv: Invocation): Promise<number> {
  if (!interactive()) {
    log.err("the fullscreen interface needs a terminal");
    log.plain("     Use `red-dev` for the menu, or a command directly.");
    return 1;
  }

  const { runTui } = await import("./tui.ts");

  // The interview, built here and answered inside the interface.
  //
  // Picking Install used to converge the whole manifest immediately.
  // The questions existed and were unreachable from this path — gated on
  // a first run and on there being no scope argument — so the one-liner,
  // which is how anyone actually arrives, never asked anything.
  const { buildSetupSteps, applySetupAnswers } = await import("./firstrun.ts");
  const { steps, wizard } = await buildSetupSteps(p);
  const setup = {
    steps,
    wizard,
    apply: (
      answers: Awaited<ReturnType<typeof applySetupAnswers>>["answers"],
      observer?: Parameters<typeof applySetupAnswers>[3],
    ) => applySetupAnswers(p, inv, answers, observer),
  };

  // The converge is handed to the interface rather than run after it.
  //
  // It used to return here and start a second render, which is what
  // crashed on Windows: the second initializeApp failed and its cleanup
  // wrote to a stdout that was already gone, so the process died and
  // took the console with it. One render now owns both views.
  const result = await runTui(
    p,
    {
      platform: p,
      ctx: await contextFor(p, inv, "install"),
      scopes: resolveScopes(p, inv.scope),
    },
    // Every one of these runs inside the interface now. Choosing a theme
    // used to leave the fullscreen, apply it, and print to the console
    // you had just been taken out of — which reads as the program
    // quitting on you. Only `install` had been moved in, which made the
    // inconsistency worse rather than better.
    // Theme and doctor only. Both are pure output, which is what makes
    // them safe to run inside a live render.
    //
    // `apps` is deliberately not here: it opens a selection prompt,
    // which draws its own interface — a second one, on top of this one,
    // which is the shape that crashed. It still leaves the fullscreen
    // first, and making that stop requires the prompt to become a view
    // in here rather than a separate UI.
    {
      applyTheme: (slug) => cmdTheme(p, inv, slug),
      doctor: () => cmdDoctor(p, inv),
      setup,
    },
  );

  switch (result.action) {
    case "theme":
      return result.theme ? await cmdTheme(p, inv, result.theme) : 0;
    case "installed":
      return (result.failed ?? 0) > 0 ? 1 : 0;
    case "doctor":
      return await cmdDoctor(p, inv);
    case "apps":
      return await cmdApps(p, inv);
    default:
      return 0;
  }
}

/**
 * Set WSL 2 up from the Windows side, on demand rather than only during a
 * first run — someone who declined at setup should not have to reset
 * their preferences to change their mind.
 */
async function cmdWsl(p: Platform): Promise<number> {
  if (p.env === "wsl") {
    const { detectWsl } = await import("./wsl-provision.ts");
    const state = await detectWsl();
    const name = process.env["WSL_DISTRO_NAME"];
    const distro = state.distributions.find((item) => item.name === name);
    if (distro?.version === 2) {
      log.ok(`${distro.name} is using WSL 2`);
      return 0;
    }

    const label = name ?? "this distro";
    const commandName = name ?? "<distro>";
    log.err(`${label} is not confirmed as WSL 2`);
    log.plain("     A running distro cannot safely convert itself. In PowerShell run:");
    log.plain(`       wsl --shutdown`);
    log.plain(`       wsl --set-default-version 2`);
    log.plain(`       wsl --set-version ${commandName} 2`);
    return 1;
  }

  if (p.os !== "windows") {
    log.skip("this sets WSL 2 up from the Windows side");
    return 0;
  }
  const { offerWsl } = await import("./wsl-provision.ts");
  await offerWsl(p);
  return 0;
}

/**
 * Choose coding agents, then wire them up.
 *
 * Pre-ticked with what `core` used to install unconditionally, so the
 * default outcome is unchanged and the decision is now made rather than
 * assumed.
 */
async function cmdAgents(p: Platform, inv: Invocation): Promise<number> {
  const { AGENTS, availableAgents, isAgentInstalled, isAgentReady, installAgent, installRedSkills } =
    await import("./agents.ts");
  const available = availableAgents(p);

  // This is the path the Windows side uses to reproduce the selection
  // inside WSL. It is deliberately prompt-free and accepts only keys
  // from the closed catalog before any installer or shell is reached.
  if (inv.agentKeys !== undefined) {
    const unknown = inv.agentKeys.filter((key) => !AGENTS.some((agent) => agent.key === key));
    if (unknown.length > 0) {
      log.err(`unknown agent(s): ${unknown.join(", ")}`);
      log.plain(`     known agents: ${AGENTS.map((agent) => agent.key).join(", ")}`);
      return 1;
    }

    const hostKeys = inv.agentKeys.filter((key) =>
      available.some((agent) => agent.key === key),
    );
    for (const key of inv.agentKeys.filter((candidate) => !hostKeys.includes(candidate))) {
      log.skip(`${key}: no compatible installer for this side`);
    }

    let failures = 0;
    if (hostKeys.length > 0) {
      const { carryOutChoices } = await import("./firstrun.ts");
      await carryOutChoices(
        p,
        { agents: hostKeys, runtimes: [], apps: [] },
        {
          stepEnd: (result) => {
            if (result.outcome === "failed") failures++;
          },
        },
      );
    }

    // An explicit command executed inside WSL is the far side of this
    // bridge. Only the native Windows invocation owns the shared choice
    // and may trigger another sync, which makes recursion impossible.
    if (p.os === "windows") {
      const { writePreferences } = await import("./preferences.ts");
      await writePreferences(p, { agents: inv.agentKeys });
      const { syncSelectedTooling } = await import("./wsl-sync.ts");
      failures += await syncSelectedTooling(p);
    }
    return failures > 0 ? 1 : 0;
  }

  // The pre-ticked list is a starting point for a human, not a default
  // to act on unattended. checkbox() returns its fallback without a
  // TTY, so leaving this unguarded meant `red-dev agents` in a script
  // installed three agents having asked nobody.
  if (!interactive()) {
    log.err("choosing agents needs a terminal");
    log.plain("     For unattended installs, name them explicitly:");
    log.plain("       red-dev agents claude-code,codex");
    return 1;
  }

  const { checkbox, confirm } = await import("./ui.ts");
  const labels = available.map(
    (a) => `${a.key} — ${a.label}, ${a.about}${isAgentInstalled(a) ? "  (installed)" : ""}`,
  );
  const preTicked = labels.filter((_, i) => available[i]?.recommended);

  const picked = await checkbox("Which agents?", labels as [string, ...string[]], preTicked);
  if (picked.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  const keys = picked.map((l) => l.split(" ")[0]!);
  let failures = 0;

  const { writePreferences } = await import("./preferences.ts");
  await writePreferences(p, { agents: keys });

  for (const key of keys) {
    const agent = available.find((a) => a.key === key);
    if (!agent) continue;
    if (await isAgentReady(agent)) {
      log.skip(`${agent.label} already present`);
      continue;
    }
    try {
      await installAgent(agent, p);
      log.ok(agent.label);
    } catch (err) {
      log.err(`${agent.label}: ${(err as Error).message}`);
      failures++;
    }
  }

  // red-skills configures whichever agents exist, so it only means
  // anything once at least one does — and it is worth asking about
  // rather than assuming, since it writes into each agent's own config.
  const anyCli = keys.some((key) => !available.find((agent) => agent.key === key)?.desktopOnly);
  if (anyCli) {
    log.plain("");
    if (await confirm("Install red-skills for these agents?", true)) {
      try {
        await installRedSkills();
        log.ok("red-skills");
      } catch (err) {
        log.err(`red-skills: ${(err as Error).message}`);
        failures++;
      }
    }
  }

  if (p.os === "windows") {
    const { syncSelectedTooling } = await import("./wsl-sync.ts");
    failures += await syncSelectedTooling(p);
  }

  return failures > 0 ? 1 : 0;
}

/** Choose which language runtimes mise manages. */
async function cmdLang(p: Platform, inv: Invocation): Promise<number> {
  const { checkbox } = await import("./ui.ts");
  const { OFFERED_RUNTIMES, useRuntimes, currentRuntimes } = await import("./runtimes.ts");

  let ids = inv.runtimeIds;
  if (ids !== undefined) {
    const known = new Set(OFFERED_RUNTIMES.map((runtime) => runtime.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      log.err(`unknown runtime(s): ${unknown.join(", ")}`);
      log.plain(`     known runtimes: ${OFFERED_RUNTIMES.map((runtime) => runtime.id).join(", ")}`);
      return 1;
    }
  } else {
    if (!interactive()) {
      log.err("choosing runtimes needs a terminal");
      log.plain("     For unattended installs, name them explicitly:");
      log.plain("       red-dev lang node@lts,bun@latest");
      return 1;
    }

    const current = await currentRuntimes();
    const labels = OFFERED_RUNTIMES.map((r) => {
      const name = r.id.split("@")[0]!;
      return `${r.id} — ${r.about}${current.includes(name) ? "  (installed)" : ""}`;
    });

    const picked = await checkbox("Which runtimes?", labels as [string, ...string[]], []);
    ids = picked.map((label) => label.split(" ")[0]!.trim());
  }

  if (ids.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  let failures = 0;
  try {
    await useRuntimes(ids, {
      stepEnd: (_id, error) => {
        if (error) failures++;
      },
    });
  } catch (err) {
    log.err((err as Error).message);
    if (failures === 0) failures++;
  }

  // The child WSL command is explicit, so it applies the selection but
  // does not rewrite the workstation preference or call back to Windows.
  if (inv.runtimeIds === undefined || p.os === "windows") {
    const { writePreferences } = await import("./preferences.ts");
    await writePreferences(p, { runtimes: ids });
  }
  if (p.os === "windows") {
    const { syncSelectedTooling } = await import("./wsl-sync.ts");
    failures += await syncSelectedTooling(p);
  }

  if (failures === 0) log.ok("runtimes updated — open a new shell");
  return failures > 0 ? 1 : 0;
}

/**
 * Bare `red-dev`.
 *
 * Fullscreen is the default now, not a separate `ui` command. That was
 * the ask, and putting the richer interface behind a verb meant almost
 * nobody would see it: someone typing `red-dev` gets the thing the
 * project actually builds.
 *
 * Two fallbacks, both narrower than they look. No terminal prints help,
 * because a menu waiting on input that is never coming is a hang. Under
 * 60 columns falls back to the line-based menu, because two columns
 * cannot lay out there and a clipped panel is worse than a plain list.
 */
async function cmdMenu(p: Platform, inv: Invocation, cliHelp: string): Promise<number> {
  if (!interactive()) {
    log.plain(cliHelp);
    return 0;
  }

  if ((process.stdout.columns ?? 0) >= 60) {
    return await cmdUi(p, inv);
  }

  const { runMenu } = await import("./menu.ts");
  return await runMenu(p, inv, cliHelp, {
    install: () => cmdInstall(p, inv),
    update: () => cmdUpdate(p, inv),
    doctor: () => cmdDoctor(p, inv),
    plan: () => cmdPlan(p, inv),
    platform: () => cmdPlatform(p),
    apps: () => cmdApps(p, inv),
    lang: () => cmdLang(p, inv),
    shell: () => cmdShell(p, inv),
    uninstall: () => cmdUninstall(p),
    applyTheme: (name) => cmdTheme(p, inv, name),
    applyFont: async (font, size) => {
      const wsl = await import("./wsl.ts");
      const spec = wsl.NERD_FONTS[font];
      const ctx = await contextFor(p, inv, "theme");
      if (!spec) return;
      const { configureAlacritty } = await import("./alacritty.ts");
      await configureAlacritty({
        platform: p,
        fontFamily: spec.family,
        fontSize: size,
        opacity: ctx.opacity,
      });
    },
  });
}

// This binary is production, and saying so is what silences tuiuiu's
// development warnings.
//
// It printed "createSignal() was called during component render at
// node:async_hooks:62" across the top of the interface — a warning about
// a line of ours that does not exist. The check walks the stack for the
// first frame outside the library, and decides "outside" by comparing
// against a package root derived from import.meta.url. Inside a
// `bun build --compile` binary there is no node_modules to compare
// against, so tuiuiu's own frames fail the test and it reports itself,
// pointing at a Node internal. Nothing in src/ creates a signal during
// render; that was fixed, and this is a different bug wearing the same
// message. Real warnings still appear when running from source.
// Set, not defaulted — the guard that used to be here never fired.
//
// `if (!process.env.NODE_ENV)` assumed the variable would be empty in a
// shipped binary. It is not: bun build --compile bakes in
// NODE_ENV="development", so the condition was false on every run and
// the suppression released in 0.9.5 never once took effect. The warning
// it was meant to silence came back the moment anyone looked, which is
// how it was found.
//
// There is no runtime escape hatch, and claiming one was the second
// mistake in this area. `--define` substitutes the value into every
// module at build time, so tuiuiu's check is already decided before this
// program starts — an env var cannot reach it, and neither can this
// assignment. It stays only so the value is right when running from
// source, where nothing is substituted.
//
// To see the warnings: bun run build:debug, which is the same build
// without the define.
process.env.NODE_ENV = "production";

/**
 * Leave a trace when the process dies.
 *
 * A fullscreen app that crashes on Windows takes the console with it,
 * so the stack scrolls past inside a window that is already closing and
 * there is nothing left to report but "it crashed". Writing it to a file
 * first turns that into something diagnosable — and the file is the only
 * copy that survives the window.
 *
 * Deliberately synchronous: an async write loses the race with process
 * death, which is the one case this exists for.
 */
function recordCrash(kind: string, err: unknown): void {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  const dir =
    process.platform === "win32"
      ? `${process.env["LOCALAPPDATA"] ?? "."}\\red-dev`
      : `${process.env["HOME"] ?? "."}/.local/state/red-dev`;
  const path = `${dir}${process.platform === "win32" ? "\\" : "/"}crash.log`;
  const entry = `\n=== ${new Date().toISOString()} ${kind} red-dev ${VERSION} ${process.platform} ===\n${detail}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(path, entry);
  } catch {
    // Nothing useful to do if even this fails; the console copy below
    // is the fallback.
  }
  // stderr as well as the file: on a terminal that survives, the user
  // should not have to know a log file exists.
  process.stderr.write(`\x1b[?1049l${entry}\nrecorded to ${path}\n`);
}

process.on("uncaughtException", (err) => {
  recordCrash("uncaughtException", err);
  process.exit(70);
});
process.on("unhandledRejection", (err) => {
  recordCrash("unhandledRejection", err);
  process.exit(70);
});

async function main(): Promise<number> {
  const cli = buildCli();
  const argv = process.argv.slice(2);

  // Handled before parsing: the schema runs in strict mode, so an
  // undeclared --help would be rejected as an unknown option before we
  // ever got the chance to honour it. Declaring them as real options
  // would instead make them appear in every command's option list,
  // which is noise.
  if (argv.includes("--version") || argv.includes("-V")) {
    log.plain(VERSION);
    return 0;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    const verb = argv.find((a) => !a.startsWith("-"));
    log.plain(cli.help(verb ? [verb] : undefined));
    return 0;
  }

  const inv = parseArgs(cli, argv);

  if (inv.errors.length > 0) {
    // Strict mode puts unrecognised commands here too, already carrying
    // the list of real ones, so there is nothing extra to print.
    for (const e of inv.errors) log.err(e);
    return 1;
  }

  const p = detect();

  switch (inv.command) {
    case "platform":
      return cmdPlatform(p);
    case "plan":
      return await cmdPlan(p, inv);
    case "doctor":
      return await cmdDoctor(p, inv);
    case "logs":
      return await cmdLogs(inv.logsWhich);
    case "install":
      return await cmdInstall(p, inv);
    case "update":
      return await cmdUpdate(p, inv);
    case "theme":
      return await cmdTheme(p, inv, inv.scope);
    case "apps":
      return await cmdApps(p, inv);
    case "agents":
      return await cmdAgents(p, inv);
    case "lang":
      return await cmdLang(p, inv);
    case "shell":
      return await cmdShell(p, inv);
    case "share": {
      const mod = await import("./shared-root.ts");
      // The positional doubles as both: `red-dev share` reports, a path
      // sets the root, and `adopt <tool>` moves one config in.
      if (inv.shareTarget === "adopt") {
        if (!inv.shareTool) {
          log.plain(`shareable: ${mod.adoptableTools().join(", ")}`);
          return 0;
        }
        return await mod.adoptConfig(p, inv.shareTool);
      }
      return await mod.chooseSharedRoot(p, inv.shareTarget);
    }
    case "uninstall":
      return await cmdUninstall(p);
    case "wsl":
      return await cmdWsl(p);
    case "ui":
      return await cmdUi(p, inv);
    case "menu":
    case null:
      return await cmdMenu(p, inv, cli.help());
    default:
      log.err(`unhandled command: ${inv.command}`);
      return 1;
  }
}

/**
 * Show a transcript, or list them.
 *
 * The current run's own log is excluded from `red-dev logs` with no
 * argument: it exists, it is one line long, and printing it instead of
 * the converge someone is trying to read would be a small joke at their
 * expense.
 */
async function cmdLogs(which?: string): Promise<number> {
  const { recentTranscripts, transcriptDir, transcriptPath } = await import("./transcript.ts");
  const mine = transcriptPath();
  const all = recentTranscripts().filter((f) => f !== mine);

  if (all.length === 0) {
    log.skip(`no transcripts yet — they are written to ${transcriptDir()}`);
    return 0;
  }

  if (which === "list") {
    log.ok(`${all.length} transcript(s) in ${transcriptDir()}`);
    for (const [i, f] of all.entries()) {
      const size = Bun.file(f).size;
      log.plain(`  ${String(i + 1).padStart(2)}  ${f.split("/").pop()}  ${(size / 1024).toFixed(1)}k`);
    }
    return 0;
  }

  const n = which ? Number.parseInt(which, 10) : 1;
  if (!Number.isFinite(n) || n < 1) {
    log.err(`'${which}' is neither 'list' nor a run number`);
    return 1;
  }
  const target = all[n - 1];
  if (!target) {
    log.err(`there are only ${all.length} transcript(s)`);
    return 1;
  }

  // Written through stdout rather than log.plain: a transcript is
  // content, not a message about the run, and routing it through the
  // logger would tee it straight back into the transcript being written.
  process.stdout.write(await Bun.file(target).text());
  return 0;
}

/**
 * Run, and write down what happened.
 *
 * Wrapped around main rather than inside it so a throw is transcribed
 * too — the run that ends in a stack trace is the one most worth having
 * a log of, and a try/finally is the only way to be sure the exit line
 * is written on every path out.
 *
 * `--version` and `--help` are excluded by the time this runs only in
 * the sense that they are cheap; they get a transcript like everything
 * else, and the rotation keeps that from mattering.
 */
async function run(): Promise<number> {
  const { startTranscript, finishTranscript } = await import("./transcript.ts");
  const command = process.argv.slice(2).join(" ") || "menu";
  await startTranscript(command, VERSION, new Date());

  let code = 70;
  try {
    code = await main();
    return code;
  } finally {
    const path = finishTranscript(code);
    // Printed after the interface has released the screen, and only
    // when something went wrong: a path nobody needs, on every
    // successful run, is noise that trains people to stop reading.
    if (path && code !== 0) log.plain(`       log: ${path}`);
  }
}

process.exit(await run());
