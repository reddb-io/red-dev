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
  return { root: findRoot(), platform: p, theme: inv.themeName, font: inv.font };
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
      const state = tool.managed ? " (managed)" : isInstalled(tool) ? " (present)" : "";
      log.plain(`  ${tool.name.padEnd(17)}${describeProvider(pr)}${state}`);
    }
  }
  return 0;
}

function cmdDoctor(p: Platform, inv: Invocation): number {
  let missing = 0;
  for (const scope of resolveScopes(p, inv.scope)) {
    for (const tool of toolsInScope(scope)) {
      const pr = providerFor(tool, p);
      if (pr.kind === "skip") {
        log.skip(`${tool.name} — ${pr.reason}`);
      } else if (tool.managed) {
        // Not a binary on PATH, so "missing" is the wrong word. The
        // provider is idempotent; converging is how you find out.
        log.plain(`     ${tool.name} — managed, run install to converge`);
      } else if (isInstalled(tool)) {
        log.ok(tool.name);
      } else {
        log.err(`${tool.name} missing (${describeProvider(pr)})`);
        missing++;
      }
    }
  }
  if (missing > 0) {
    log.warn(`${missing} missing — run: red-dev install`);
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

  if (p.env !== "wsl" && p.os !== "windows") {
    log.warn(`theme switching on ${p.env} targets is not implemented yet`);
    return 1;
  }

  try {
    const wsl = await import("./wsl.ts");
    const spec = wsl.NERD_FONTS[inv.font];
    if (!spec) {
      log.err(`unknown font '${inv.font}'`);
      return 1;
    }
    await wsl.configureWindowsTerminal({
      fontFace: spec.family,
      theme,
      distro: process.env["WSL_DISTRO_NAME"] ?? undefined,
      home: process.env["HOME"] ?? undefined,
    });
    log.ok(`theme: ${theme.name} — open a new terminal tab to see it`);
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
    case "plan":
      return cmdPlan(p, inv);
    case "doctor":
      return cmdDoctor(p, inv);
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
    for (const e of inv.errors) log.err(e);
    return 1;
  }
  if (inv.unknown.length > 0) {
    log.err(`unknown command: ${inv.unknown[0]}`);
    log.plain(cli.help());
    return 1;
  }

  const p = detect();

  switch (inv.command) {
    case "platform":
      return cmdPlatform(p);
    case "plan":
      return cmdPlan(p, inv);
    case "doctor":
      return cmdDoctor(p, inv);
    case "install":
      return await cmdInstall(p, inv);
    case "update":
      return await cmdUpdate(p, inv);
    case "theme":
      return await cmdTheme(p, inv, inv.scope);
    case "menu":
    case null:
      return await cmdMenu(p, inv, cli.help());
    default:
      log.err(`unhandled command: ${inv.command}`);
      return 1;
  }
}

process.exit(await main());
