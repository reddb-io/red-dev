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
} from "./manifest.ts";
import { detect, summary, type Platform } from "./platform.ts";
import { aptInstall, applyProvider, systemUpdate, type ApplyContext } from "./providers.ts";
import { THEMES, themeNames } from "./themes.ts";
import { interactive, select } from "./ui.ts";

function resolveScopes(p: Platform, arg?: string): Scope[] {
  return arg ? [arg as Scope] : applicableScopes(p);
}

function contextFor(p: Platform, inv: Invocation): ApplyContext {
  return {
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
  let ctx = contextFor(p, inv);
  let extraScopes: Scope[] = [];

  // Ask once, on a real terminal, when this machine is new. Every ui.ts
  // primitive returns its fallback without a TTY, so this is inert in
  // CI, in a pipe and over a non-interactive SSH — which is what makes
  // asking safe rather than something to avoid entirely.
  if (!inv.dryRun && !inv.yes && !inv.scope) {
    const { isFirstRun, askFirstRun, writeShellEnv } = await import("./firstrun.ts");
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
        if (choices.runtimes.length > 0) {
          const { useRuntimes } = await import("./runtimes.ts");
          try {
            await useRuntimes(choices.runtimes);
          } catch (err) {
            log.warn(`runtimes: ${(err as Error).message}`);
          }
        }
      }
    }
  }

  log.step(summary(p).split("\n")[0] ?? "");

  const { Reporter } = await import("./report.ts");
  const report = new Reporter();

  for (const scope of [...resolveScopes(p, inv.scope), ...extraScopes]) {
    const tools = toolsInScope(scope);
    report.scope(scope, tools.length);

    // Batched apt first, because twenty sequential apt-get calls is the
    // slowest part of a fresh provision and each re-reads the package
    // lists. Resolved up front so the per-tool loop below can report
    // each one as its own step rather than hiding them all behind one
    // opaque transaction.
    const pending = tools.filter(
      (t) => providerFor(t, p).kind !== "skip" && !isInstalled(t),
    );
    const aptPkgs = pending
      .map((t) => providerFor(t, p))
      .filter((pr): pr is { kind: "apt"; pkg: string } => pr.kind === "apt")
      .map((pr) => pr.pkg);

    let aptError: string | null = null;
    if (!inv.dryRun && aptPkgs.length > 0) {
      report.note(`apt: ${aptPkgs.length} packages in one transaction`);
      try {
        await aptInstall(aptPkgs);
      } catch (err) {
        aptError = (err as Error).message;
      }
    }

    for (const tool of tools) {
      const pr = providerFor(tool, p);
      const label = describeProvider(pr);

      if (pr.kind === "skip") {
        report.begin(tool.name, "—")("skipped", pr.reason);
        continue;
      }
      if (isInstalled(tool)) {
        report.begin(tool.name, label)("present");
        continue;
      }
      if (inv.dryRun) {
        report.begin(tool.name, label)("skipped", "dry run");
        continue;
      }

      const done = report.begin(tool.name, label);
      if (pr.kind === "apt") {
        // Already attempted in the batch above; report the real state
        // rather than claiming a per-tool install that never ran.
        if (aptError) done("failed", aptError);
        else done(isInstalled(tool) ? "installed" : "failed", "apt reported success but the binary is absent");
        continue;
      }

      try {
        await applyProvider(pr, ctx);
        // A managed builtin converges rather than installs, and on a
        // second run legitimately changes nothing.
        done(tool.managed ? "applied" : "installed");
      } catch (err) {
        // One tool failing must not abort the run: the point of a
        // converge tool is that you re-run it and it picks up the rest.
        done("failed", (err as Error).message);
      }
    }
  }

  const { failed } = report.finish();

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
    const { applied, skipped } = await applyThemeEverywhere(theme, p, chosen);
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
    const theme = THEMES[inv.themeName];
    const spec = wsl.NERD_FONTS[inv.font];
    if (theme && spec) {
      await configureAlacritty({
        platform: p,
        theme,
        fontFamily: spec.family,
        opacity: inv.opacity,
      });
    }
    log.plain("     open a new terminal window to see it");
  } catch (err) {
    log.warn(`alacritty: ${(err as Error).message}`);
  }

  return 0;
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

async function cmdMenu(p: Platform, inv: Invocation, cliHelp: string): Promise<number> {
  if (!interactive()) {
    // Piped or redirected: a menu would block on input that is never
    // coming. Print help, which is what a script most likely wants.
    log.plain(cliHelp);
    return 0;
  }

  const { runMenu } = await import("./menu.ts");
  return await runMenu(p, inv, cliHelp, {
    install: () => cmdInstall(p, inv),
    update: () => cmdUpdate(p, inv),
    doctor: () => cmdDoctor(p, inv),
    plan: () => cmdPlan(p, inv),
    platform: () => cmdPlatform(p),
    apps: () => cmdApps(p, inv),
    lang: () => cmdLang(),
    shell: () => cmdShell(p, inv),
    applyTheme: (name) => cmdTheme(p, inv, name),
    applyFont: async (font, size) => {
      const wsl = await import("./wsl.ts");
      const spec = wsl.NERD_FONTS[font];
      const theme = THEMES[inv.themeName];
      if (!spec || !theme) return;
      const { configureAlacritty } = await import("./alacritty.ts");
      await configureAlacritty({
        platform: p,
        theme,
        fontFamily: spec.family,
        fontSize: size,
        opacity: inv.opacity,
      });
    },
  });
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
    case "shell":
      return await cmdShell(p, inv);
    case "menu":
    case null:
      return await cmdMenu(p, inv, cli.help());
    default:
      log.err(`unhandled command: ${inv.command}`);
      return 1;
  }
}

process.exit(await main());
