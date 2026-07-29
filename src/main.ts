#!/usr/bin/env bun
/**
 * red-dev — one dev environment across Ubuntu 24, Ubuntu 26, WSL and Windows.
 */

import { buildCli, parseArgs, VERSION, type Invocation } from "./cli.ts";
import { log } from "./log.ts";
import {
  applicableScopes,
  describeProvider,
  isInstalled,
  providerFor,
  toolsInScope,
  type Scope,
  type Tool,
} from "./manifest.ts";
import { detect, summary, type Platform } from "./platform.ts";
import { aptInstall, applyProvider, systemUpdate, type ApplyContext } from "./providers.ts";
import { THEMES, themeNames } from "./themes.ts";
import { banner, interactive, select } from "./ui.ts";

/**
 * Where the shipped config lives. A compiled binary can run from
 * anywhere, so allow an explicit override; otherwise assume we sit in
 * <root>/bin, <root>/src or <root>/dist.
 */
function findRoot(): string {
  const override = process.env["RED_ROOT"];
  if (override) return override;
  return import.meta.dir.replace(/[\\/](src|bin|dist)$/, "");
}

function resolveScopes(p: Platform, arg?: string): Scope[] {
  return arg ? [arg as Scope] : applicableScopes(p);
}

function contextFor(p: Platform, inv: Invocation): ApplyContext {
  return {
    root: findRoot(),
    platform: p,
    theme: inv.themeName,
    font: inv.font,
    opacity: inv.opacity,
  };
}

function cmdPlatform(p: Platform): number {
  log.plain(summary(p));
  return 0;
}

function cmdPlan(p: Platform, inv: Invocation): number {
  for (const scope of resolveScopes(p, inv.scope)) {
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
              : "";
      log.plain(`  ${tool.name.padEnd(17)}${describeProvider(pr)}${state}`);
    }
  }
  return 0;
}

async function cmdDoctor(p: Platform, inv: Invocation): Promise<number> {
  let missing = 0;

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
  if (missing > 0 || drifted > 0) {
    log.warn(`${missing} tool(s) missing, ${drifted} config drift(s)`);
    return 1;
  }
  log.ok("no drift");
  return 0;
}

async function cmdInstall(p: Platform, inv: Invocation): Promise<number> {
  const ctx = contextFor(p, inv);
  log.step(summary(p).split("\n")[0] ?? "");

  let failures = 0;
  for (const scope of resolveScopes(p, inv.scope)) {
    log.step(`scope: ${scope}`);

    const pending: Tool[] = toolsInScope(scope).filter((t) => {
      const pr = providerFor(t, p);
      if (pr.kind === "skip") {
        log.skip(`${t.name} — ${pr.reason}`);
        return false;
      }
      if (isInstalled(t)) {
        log.skip(`${t.name} already present`);
        return false;
      }
      return true;
    });

    if (inv.dryRun) {
      for (const t of pending) {
        log.plain(`  would install ${t.name} via ${describeProvider(providerFor(t, p))}`);
      }
      continue;
    }

    // apt is batched into one transaction; everything else runs per tool.
    const aptPkgs = pending
      .map((t) => providerFor(t, p))
      .filter((pr): pr is { kind: "apt"; pkg: string } => pr.kind === "apt")
      .map((pr) => pr.pkg);

    if (aptPkgs.length > 0) {
      try {
        await aptInstall(aptPkgs);
      } catch (err) {
        log.err(`apt batch failed: ${(err as Error).message}`);
        failures++;
      }
    }

    for (const tool of pending) {
      const pr = providerFor(tool, p);
      if (pr.kind === "apt") continue;
      try {
        await applyProvider(pr, ctx);
      } catch (err) {
        // One tool failing must not abort the run: the point of a
        // converge tool is that you re-run it and it picks up the rest.
        log.err(`${tool.name}: ${(err as Error).message}`);
        failures++;
      }
    }
  }

  if (inv.dryRun) {
    log.ok("dry run — nothing changed");
    return 0;
  }
  if (failures > 0) {
    log.warn(`${failures} step(s) failed — re-run 'red-dev install' after fixing`);
    return 1;
  }
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
  // Upgrading can leave the manifest unsatisfied (a package removed, a
  // binary replaced), so always re-converge afterwards.
  return await cmdInstall(p, inv);
}

async function cmdTheme(p: Platform, inv: Invocation, name?: string): Promise<number> {
  const chosen =
    name ?? (await select("Theme?", themeNames() as [string, ...string[]], inv.themeName));
  const theme = THEMES[chosen];
  if (!theme) {
    log.err(`unknown theme '${chosen}' (known: ${themeNames().join(", ")})`);
    return 1;
  }

  const wsl = await import("./wsl.ts");
  const spec = wsl.NERD_FONTS[inv.font];
  if (!spec) {
    log.err(`unknown font '${inv.font}'`);
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
      theme,
      fontFamily: spec.family,
      opacity: inv.opacity,
    });
  } catch (err) {
    log.err(`alacritty: ${(err as Error).message}`);
    failures++;
  }

  // Everything that is not the terminal emulator: multiplexer, system
  // monitor, editor. Colouring only the terminal is what makes a theme
  // switch feel half-applied.
  try {
    const { applyThemeEverywhere } = await import("./theme-apply.ts");
    const { applied, skipped } = await applyThemeEverywhere(theme, p);
    if (applied.length > 0) log.ok(`themed: ${applied.join(", ")}`);
    if (skipped.length > 0) log.skip(`not present: ${skipped.join(", ")}`);
  } catch (err) {
    log.warn(`theme surfaces: ${(err as Error).message}`);
  }

  const { applyWallpaperLogged } = await import("./wallpaper.ts");
  await applyWallpaperLogged(theme, chosen, p);

  if (p.env === "wsl" || p.os === "windows") {
    try {
      await wsl.configureWindowsTerminal({
        fontFace: spec.family,
        theme,
        opacity: inv.opacity,
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
  const ctx = contextFor(p, inv);
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

/** Choose which language runtimes mise manages. */
async function cmdLang(): Promise<number> {
  const { checkbox } = await import("./ui.ts");
  const { OFFERED_RUNTIMES, useRuntimes, currentRuntimes } = await import("./runtimes.ts");

  const current = await currentRuntimes();
  const labels = OFFERED_RUNTIMES.map((r) => {
    const name = r.id.split("@")[0]!;
    return `${r.id} — ${r.about}${current.includes(name) ? "  (installed)" : ""}`;
  });

  const picked = await checkbox("Which runtimes?", labels as [string, ...string[]], []);
  if (picked.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  try {
    await useRuntimes(picked.map((l) => l.split(" ")[0]!.trim()));
    log.ok("runtimes updated — open a new shell");
    return 0;
  } catch (err) {
    log.err((err as Error).message);
    return 1;
  }
}

const MENU = [
  "install — converge this machine",
  "update — upgrade installed packages",
  "theme — change colour scheme",
  "apps — choose optional tools",
  "lang — choose language runtimes",
  "plan — preview changes",
  "doctor — report drift",
  "platform — show detection",
  "quit",
] as const;

async function cmdMenu(p: Platform, inv: Invocation, cliHelp: string): Promise<number> {
  if (!interactive()) {
    // Piped or redirected: a menu would block on input that is never
    // coming. Print help, which is what a script most likely wants.
    log.plain(cliHelp);
    return 0;
  }

  log.plain(banner(summary(p).split("\n")[0] ?? ""));
  const choice = await select("What now?", MENU, "quit");

  switch (choice.split(" ")[0]) {
    case "install":
      return await cmdInstall(p, inv);
    case "update":
      return await cmdUpdate(p, inv);
    case "theme":
      return await cmdTheme(p, inv);
    case "apps":
      return await cmdApps(p, inv);
    case "lang":
      return await cmdLang();
    case "plan":
      return cmdPlan(p, inv);
    case "doctor":
      return await cmdDoctor(p, inv);
    case "platform":
      return cmdPlatform(p);
    default:
      return 0;
  }
}

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
      return cmdPlan(p, inv);
    case "doctor":
      return await cmdDoctor(p, inv);
    case "install":
      return await cmdInstall(p, inv);
    case "update":
      return await cmdUpdate(p, inv);
    case "theme":
      return await cmdTheme(p, inv, inv.scope);
    case "apps":
      return await cmdApps(p, inv);
    case "lang":
      return await cmdLang();
    case "menu":
    case null:
      return await cmdMenu(p, inv, cli.help());
    default:
      log.err(`unhandled command: ${inv.command}`);
      return 1;
  }
}

process.exit(await main());
