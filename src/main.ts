#!/usr/bin/env bun
/**
 * red — one dev environment across Ubuntu 24, Ubuntu 26, WSL and Windows.
 */

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
import { aptInstall, applyProvider, systemUpdate } from "./providers.ts";
import { banner, interactive, select } from "./ui.ts";

/**
 * Where the shipped config lives. A compiled binary can be run from
 * anywhere, so allow an explicit override; otherwise assume we sit in
 * <root>/bin or <root>/src.
 */
function findRoot(): string {
  const override = process.env["RED_ROOT"];
  if (override) return override;
  const dir = import.meta.dir;
  return dir.replace(/[\\/](src|bin|dist)$/, "");
}

const USAGE = `red-dev — cross-platform dev environment

  red-dev                    interactive menu (when attached to a terminal)
  red-dev platform           show what red-dev thinks this machine is
  red-dev plan [scope]       list what would change, change nothing
  red-dev install [scope]    converge this machine toward the manifest
  red-dev update             upgrade what the package managers own
  red-dev doctor             report drift against the manifest

Scopes: core, desktop, wsl
  core     the identical-experience layer, every target
  desktop  bare-metal Ubuntu only (GUI apps, GNOME)
  wsl      WSL only (acts on the Windows host via interop)
`;

function resolveScopes(p: Platform, arg?: string): Scope[] {
  if (!arg) return applicableScopes(p);
  const valid: Scope[] = ["core", "desktop", "wsl"];
  if (!valid.includes(arg as Scope)) {
    log.err(`unknown scope: ${arg} (expected one of ${valid.join(", ")})`);
    process.exit(1);
  }
  return [arg as Scope];
}

function cmdPlatform(p: Platform): void {
  log.plain(summary(p));
}

function cmdPlan(p: Platform, scopeArg?: string): void {
  for (const scope of resolveScopes(p, scopeArg)) {
    log.plain(`\n[${scope}]`);
    for (const tool of toolsInScope(scope)) {
      const pr = providerFor(tool, p);
      const desc = describeProvider(pr);
      const mark = isInstalled(tool) ? " (present)" : "";
      log.plain(`  ${tool.name.padEnd(17)}${desc}${mark}`);
    }
  }
}

function cmdDoctor(p: Platform): number {
  let missing = 0;
  for (const scope of resolveScopes(p)) {
    for (const tool of toolsInScope(scope)) {
      const pr = providerFor(tool, p);
      if (pr.kind === "skip") {
        log.skip(`${tool.name} — ${pr.reason}`);
        continue;
      }
      if (isInstalled(tool)) {
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

async function cmdInstall(p: Platform, scopeArg?: string): Promise<number> {
  const root = findRoot();
  log.step(summary(p).split("\n")[0] ?? "");

  let failures = 0;
  for (const scope of resolveScopes(p, scopeArg)) {
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
        await applyProvider(pr, { root, platform: p });
      } catch (err) {
        // One tool failing must not abort the run: the whole point of a
        // converge tool is that you re-run it and it picks up the rest.
        log.err(`${tool.name}: ${(err as Error).message}`);
        failures++;
      }
    }
  }

  if (failures > 0) {
    log.warn(`${failures} step(s) failed — re-run 'red-dev install' after fixing`);
    return 1;
  }
  log.ok("converged — restart your shell");
  return 0;
}

async function cmdUpdate(p: Platform): Promise<number> {
  try {
    await systemUpdate(p);
  } catch (err) {
    log.err((err as Error).message);
    return 1;
  }
  // Upgrading can leave the manifest unsatisfied (a package removed, a
  // binary replaced), so always re-converge afterwards.
  return await cmdInstall(p);
}

const MENU = [
  "install — converge this machine",
  "update — upgrade installed packages",
  "plan — preview changes",
  "doctor — report drift",
  "platform — show detection",
  "quit",
] as const;

async function cmdMenu(p: Platform): Promise<number> {
  if (!interactive()) {
    // Piped or redirected: a menu would hang waiting for input that is
    // never coming. Fall back to the thing a script most likely wants.
    log.plain(USAGE);
    return 0;
  }

  log.plain(banner(summary(p).split("\n")[0] ?? ""));
  const choice = await select("What now?", MENU, "quit");

  switch (choice.split(" ")[0]) {
    case "install":
      return await cmdInstall(p);
    case "update":
      return await cmdUpdate(p);
    case "plan":
      cmdPlan(p);
      return 0;
    case "doctor":
      return cmdDoctor(p);
    case "platform":
      cmdPlatform(p);
      return 0;
    default:
      return 0;
  }
}

async function main(): Promise<number> {
  const [, , cmd, arg] = process.argv;
  const p = detect();

  switch (cmd) {
    case "platform":
      cmdPlatform(p);
      return 0;
    case "plan":
      cmdPlan(p, arg);
      return 0;
    case "doctor":
      return cmdDoctor(p);
    case "install":
      return await cmdInstall(p, arg);
    case "update":
      return await cmdUpdate(p);
    case "menu":
      return await cmdMenu(p);
    case undefined:
      return await cmdMenu(p);
    case "help":
    case "-h":
    case "--help":
      log.plain(USAGE);
      return 0;
    default:
      log.err(`unknown command: ${cmd}`);
      log.plain(USAGE);
      return 1;
  }
}

process.exit(await main());
