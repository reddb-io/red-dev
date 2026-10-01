#!/usr/bin/env bun
import { windowsWsl, resolveWorkstation } from "./workstation.ts";
/**
 * red-dev — one dev environment across Ubuntu 24, Ubuntu 26, WSL and Windows.
 */

import { buildCli, parseArgs, VERSION, type Invocation } from "./cli.ts";
import type { VerdictItem } from "./completion.ts";
import type { StepOutcome } from "./converge.ts";
import { recordCrash } from "./crash.ts";
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
import { interactive, select, text } from "./ui.ts";
import { doctorCommand as cmdDoctor } from "./doctor-command.ts";
import type { UpdateStage } from "./update-order.ts";
import type { WebApp } from "./webapps.ts";

function resolveScopes(p: Platform, arg?: string): Scope[] {
  return arg ? [arg as Scope] : applicableScopes(p);
}

/** Warm sudo while the ordinary terminal still owns stdin. */
async function prepareSudo(p: Platform, scopes: Scope[]): Promise<boolean> {
  const { primeSudoInteractive, sudoItemsFor } = await import("./sudo-preflight.ts");
  if (sudoItemsFor(p, scopes).length === 0) return false;
  await primeSudoInteractive();
  return true;
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
                : installState(tool) === "mismatched"
                  ? // Both numbers, because the found one may be the
                    // higher: "wants 0.44.1" alone reads as an upgrade
                    // on a machine that has to go the other way.
                    ` (${installedVersion(tool) ?? "unknown"}, pinned to ${tool.pinVersion})`
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
  if (windowsWsl(p)) {
    const { defaultDistroInfo, distroVersion, relayWslCommand } = await import("./wsl-sync.ts");
    const distro = await defaultDistroInfo(p);
    if (distro?.version === 2 && await distroVersion(distro.name)) return relayWslCommand(p, `red-dev plan ${inv.scope ?? ""}`);
    const linux: Platform = { ...p, os: "linux", env: "wsl", distro: "ubuntu", version: "24.04", workstation: undefined,
      caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } };
    log.plain("\n[Ubuntu/WSL — planned destinations; installation not observed]");
    for (const scope of resolveScopes(linux, inv.scope)) {
      for (const tool of toolsInScope(scope)) {
        const provider = providerFor(tool, linux);
        if (provider.kind !== "skip") log.plain(`  ${tool.name.padEnd(17)}${describeProvider(provider)}`);
      }
    }
  }
  return 0;
}

async function cmdRescue(p: Platform, inv: Invocation): Promise<number> {
  if (p.os !== "linux") {
    log.err("online Host Rescue is available on Linux and WSL");
    return 1;
  }

  const [{ collectLinuxHostSnapshot }, { assessHost }, rescue] = await Promise.all([
    import("./linux-host.ts"),
    import("./host-health.ts"),
    import("./rescue.ts"),
  ]);
  const snapshot = await collectLinuxHostSnapshot();
  const assessment = assessHost(snapshot);
  const plan = rescue.planRescue(snapshot);
  const processCount = plan.targets.reduce((sum, target) => sum + target.processes.length, 0);

  log.plain("\n[rescue]");
  if (plan.targets.length === 0) {
    log.ok("no process group is proven orphaned");
    const suspects = assessment.groups.filter((group) => group.disposition === "suspect");
    for (const group of suspects) {
      log.skip(`group ${group.pgid} is only suspect — ${group.reasons.join(", ")}`);
    }
    return 0;
  }

  log.warn(`${plan.targets.length} proven orphan group(s), ${processCount} process(es)`);
  for (const target of plan.targets) {
    const classified = assessment.groups.find((group) => group.pgid === target.pgid);
    log.plain(
      `  pgid ${target.pgid}  pids ${target.processes.map((item) => item.pid).join(",")}  ` +
        `${classified?.reasons.join(", ") ?? "proven orphan"}`,
    );
  }

  if (!inv.apply) {
    log.plain("\nPreview only. Apply exactly this policy with: red-dev rescue --apply");
    return 0;
  }

  if (!interactive() && !inv.yes) {
    log.err("non-interactive Rescue requires both --apply and --yes");
    return 1;
  }
  if (interactive() && !inv.yes) {
    const { confirm } = await import("./ui.ts");
    if (!(await confirm(`End ${plan.targets.length} proven orphan group(s)?`, false))) {
      log.skip("nothing changed");
      return 0;
    }
  }

  const result = await rescue.applyRescue(snapshot, plan, rescue.linuxRescueOptions());
  log.ok(`forensic snapshot: ${result.beforePath}`);
  for (const pgid of result.ended) log.ok(`ended process group ${pgid}`);
  for (const item of result.skipped) log.warn(`skipped ${item.pgid} — ${item.reason}`);
  for (const item of result.failed) log.err(`failed ${item.pgid} — ${item.reason}`);
  log.ok(`verification snapshot: ${result.afterPath}`);
  return result.skipped.length > 0 || result.failed.length > 0 ? 1 : 0;
}

async function cmdReclaim(p: Platform, inv: Invocation): Promise<number> {
  const reclaim = await import("./reclaim.ts");
  const cachePolicy = inv.packageCaches || inv.buildCache
    ? await import("./cache-policy.ts")
    : null;
  const { transcriptPath } = await import("./transcript.ts");
  let workerStateKnown = false;
  let workers = 0;
  let cacheWriters = 0;
  const livePids = new Set<number>();
  if (p.os === "linux") {
    const { collectLinuxHostSnapshot } = await import("./linux-host.ts");
    const snapshot = await collectLinuxHostSnapshot();
    workerStateKnown = snapshot.workerStateKnown;
    workers = snapshot.workers.length;
    for (const process of snapshot.processes) {
      livePids.add(process.pid);
      if (cachePolicy?.isCacheMutatingProcess(process)) cacheWriters++;
    }
  } else if (p.os === "windows") {
    const { readPreferences } = await import("./preferences.ts");
    const gate = await reclaim.windowsWslWorkerState((await readPreferences(p)).distro);
    workerStateKnown = gate.known;
    workers = gate.workers;
  }

  const current = transcriptPath();
  const crashDumpDir = inv.crashDumps ? await reclaim.windowsCrashDumpDir() : null;
  // Windows' Temp, where WSL leaves the swap of every session that
  // ended. Asked for only alongside the crash dumps, for the same
  // reason: these are gigabytes, and `reclaim` typed to tidy some logs
  // must not take one by surprise.
  const tempDir = inv.crashDumps ? await reclaim.windowsTempDir() : null;
  const plan = reclaim.collectReclaimPlan({
    stateRoot: reclaim.redDevStateRoot(),
    includeCrashDumps: inv.crashDumps,
    crashDumpDir,
    tempDir,
    livePids,
    protectedPaths: new Set(current ? [current] : []),
  });
  const packageCaches = inv.packageCaches && cachePolicy
    ? await cachePolicy.collectPackageCaches()
    : [];
  const cargoBuildCache = inv.buildCache && cachePolicy
    ? await cachePolicy.inspectCargoBuildCache(inv.reclaimWorkspace ?? process.cwd())
    : null;
  const selectedCaches = [
    ...packageCaches,
    ...(cargoBuildCache ? [cargoBuildCache] : []),
  ];
  const cacheActions = selectedCaches.filter((item) => item.argv !== null && item.bytes !== 0);

  log.plain("\n[reclaim]");
  if (inv.crashDumps && crashDumpDir === null) {
    log.warn("Windows CrashDumps could not be reached; none are in this plan");
  }
  if (inv.buildCache && cargoBuildCache === null) {
    log.warn("Cargo target could not be proven from workspace metadata and CACHEDIR.TAG; none is in this plan");
  }
  if (selectedCaches.length > 0) {
    log.plain("  selected cache maintenance:");
    for (const item of selectedCaches) {
      const size = item.bytes === null ? "unknown" : reclaim.formatBytes(item.bytes);
      const disposition = item.argv
        ? item.argv.join(" ")
        : item.kind.startsWith("cargo-")
          ? "Cargo native GC"
          : "inventory only";
      log.plain(`  ${item.kind.padEnd(15)} ${size.padStart(10)}  ${item.path}`);
      log.plain(`                    ${disposition} — ${item.note}`);
    }
  }
  if (plan.items.length === 0 && cacheActions.length === 0) {
    if (selectedCaches.some((item) => (item.bytes ?? 1) > 0)) {
      log.ok("inventory complete; no supported cache maintenance action is pending");
    } else {
      log.ok("all derived artifacts are within their retention budgets");
    }
    return 0;
  }
  if (plan.items.length > 0) {
    log.warn(`${plan.items.length} derived file(s), ${reclaim.formatBytes(plan.bytes)} reclaimable`);
  }
  for (const item of plan.items) {
    log.plain(
      `  ${item.kind.padEnd(15)} ${reclaim.formatBytes(item.file.size).padStart(10)}  ` +
        `${item.file.path} — ${item.reasons.join(", ")}`,
    );
  }

  if (!inv.apply) {
    const workspace = inv.reclaimWorkspace
      ? ` '${inv.reclaimWorkspace.split("'").join(`'"'"'`)}'`
      : "";
    const crash = inv.crashDumps ? " --crash-dumps" : "";
    const packages = inv.packageCaches ? " --package-caches" : "";
    const build = inv.buildCache ? " --build-cache" : "";
    log.plain(`\nPreview only. Apply this plan with: red-dev reclaim${workspace} --apply${crash}${packages}${build}`);
    return 0;
  }
  if (!workerStateKnown) {
    log.err("Reclaim refuses: Worker state is unknown; run it inside a healthy WSL/Linux environment");
    return 1;
  }
  if (workers > 0) {
    log.err(`Reclaim refuses while ${workers} Worker(s) are active`);
    return 1;
  }
  if (cacheActions.length > 0 && cacheWriters > 0) {
    log.err(`Reclaim refuses while ${cacheWriters} cache-writing build/install process(es) are active`);
    return 1;
  }
  if (!interactive() && !inv.yes) {
    log.err("non-interactive Reclaim requires both --apply and --yes");
    return 1;
  }
  if (interactive() && !inv.yes) {
    const { confirm } = await import("./ui.ts");
    if (!(await confirm(
      `Apply ${plan.items.length} file removal(s) and ${cacheActions.length} cache maintenance action(s)?`,
      false,
    ))) {
      log.skip("nothing changed");
      return 0;
    }
  }

  // A Worker may start while the preview is on screen. Re-check at the
  // destructive boundary; the earlier answer is evidence, not a lease.
  if (p.os === "linux") {
    const { collectLinuxHostSnapshot } = await import("./linux-host.ts");
    const latest = await collectLinuxHostSnapshot();
    if (!latest.workerStateKnown) {
      log.err("Reclaim refuses: Worker state became unknown before apply");
      return 1;
    }
    if (latest.workers.length > 0) {
      log.err(`Reclaim refuses: ${latest.workers.length} Worker(s) became active before apply`);
      return 1;
    }
    const latestCacheWriters = latest.processes.filter((process) =>
      cachePolicy?.isCacheMutatingProcess(process)
    ).length;
    if (cacheActions.length > 0 && latestCacheWriters > 0) {
      log.err(`Reclaim refuses: ${latestCacheWriters} cache writer(s) became active before apply`);
      return 1;
    }
  } else if (p.os === "windows") {
    const { readPreferences } = await import("./preferences.ts");
    const latest = await reclaim.windowsWslWorkerState((await readPreferences(p)).distro);
    if (!latest.known) {
      log.err("Reclaim refuses: WSL Worker state became unknown before apply");
      return 1;
    }
    if (latest.workers > 0) {
      log.err(`Reclaim refuses: ${latest.workers} Worker(s) became active before apply`);
      return 1;
    }
  }

  const result = reclaim.applyReclaim(plan);
  for (const path of result.removed) log.ok(`removed ${path}`);
  for (const item of result.skipped) log.warn(`skipped ${item.path} — ${item.reason}`);
  for (const item of result.failed) log.err(`failed ${item.path} — ${item.reason}`);
  let cacheFailed = false;
  let cacheFreed = 0;
  if (cachePolicy) {
    const outcomes = await cachePolicy.applyCacheMaintenance(cacheActions);
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        cacheFailed = true;
        log.err(`${outcome.kind} maintenance failed — ${outcome.detail}`);
      } else {
        const freed = outcome.freedBytes === null
          ? "unmeasured"
          : reclaim.formatBytes(outcome.freedBytes);
        cacheFreed += outcome.freedBytes ?? 0;
        log.ok(`${outcome.kind} maintenance completed — ${freed} reclaimed`);
      }
    }
  }
  log.ok(`reclaimed ${reclaim.formatBytes(result.removedBytes + cacheFreed)} inside the filesystem`);
  if (p.env === "wsl") {
    log.plain("       VHDX physical size changes only after a separate offline compaction");
  }
  return result.skipped.length > 0 || result.failed.length > 0 || cacheFailed ? 1 : 0;
}

async function cmdInstall(p: Platform, inv: Invocation, entry: "install" | "update" = "install"): Promise<number> {
  if (inv.dryRun) return cmdInstallUnlocked(p, inv, entry);
  const { withUpdateLock } = await import("./update-coordinator.ts");
  const held = await withUpdateLock(() => cmdInstallUnlocked(p, inv, entry));
  if (held.busy) { log.warn("another installation or update is running"); return 2; }
  return held.value;
}

async function cmdInstallUnlocked(
  p: Platform,
  inv: Invocation,
  entry: "install" | "update" = "install",
): Promise<number> {
  if (process.env["RED_DEV_UPDATE_CONVERGE"] === "1") {
    entry = "update";
    delete process.env["RED_DEV_UPDATE_CONVERGE"];
  }
  let ctx = await contextFor(p, inv, entry);
  ctx.wslUnattended = inv.yes || inv.unattended;
  let extraScopes: Scope[] = [];
  let sudoPrepared = false;

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

        // Before agents, runtimes or optional apps can reach a package
        // provider. This is a visible top-level authentication, never a
        // prompt hidden inside one of their unattended children.
        if (!inv.yes && interactive()) {
          sudoPrepared = await prepareSudo(p, [
            ...resolveScopes(p, inv.scope),
            ...extraScopes,
          ]);
        }

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

  // Move the declared packages forward before converging over them —
  // see installRefreshesDeclared for why install has to do this itself.
  // Never fatal: a machine that cannot refresh (no sudo on this run, a
  // proxy in the way) still converges against what it has.
  {
    const { installRefreshesDeclared, systemUpdate } = await import("./providers.ts");
    if (installRefreshesDeclared(entry, inv.dryRun, scopes)) {
      try {
        await systemUpdate(p, { whole: false });
      } catch (err) {
        log.warn(`declared-package refresh: ${(err as Error).message}`);
      }

      // Retire the copies a publisher's move left behind, on every core
      // install rather than only when a person picks agents. This lived
      // in the first-run interview, so a plain `red-dev install core`
      // swept nothing and the RedCode binary it was built to retire sat
      // in ~/.local/bin install after install. The gate is the same as
      // the refresh above, for the same reasons.
      const { retireLegacyAgents } = await import("./legacy-install.ts");
      const { availableAgents } = await import("./agents.ts");
      await retireLegacyAgents(p, availableAgents(p));

      // The toon VS Code extension, published as a release asset rather
      // than carried in a package set. Only where toon itself is on the
      // machine — installing an editor extension for a tool that is not
      // here would be work nobody asked for — and it defers on its own
      // where there is no display of this machine's to install into.
      const { commandPath } = await import("./agents.ts");
      if (commandPath("tq") !== null) {
        const { installToonExtension, announceVsix } = await import("./vscode-extension.ts");
        announceVsix("toon extension", await installToonExtension(p));
      }
    }
  }

  // Direct `red-dev install` reaches here without the first-run interview.
  // Prime once before either fullscreen or line reporting begins. `--yes`
  // remains strictly unattended and non-TTY runs never ask anything.
  if (!inv.dryRun && !inv.yes && interactive() && !sudoPrepared) {
    await prepareSudo(p, scopes);
  }

  // Fullscreen when there is a terminal wide enough for it: the live
  // view is the default experience, and the line report is what runs in
  // CI, in a pipe, over a dumb SSH session and on a narrow window.
  if (!inv.dryRun && interactive() && (process.stdout.columns ?? 0) >= 60 && !windowsWsl(p)) {
    const { runInstallTui } = await import("./tui-install.ts");
    const outcome = await runInstallTui({ platform: p, ctx, scopes });
    // The banner again, after the frame is released. The completion
    // screen said this inside the interface, and the interface is gone
    // by the time anyone scrolls back — the terminal has to hold the
    // verdict too, or the evidence exists only for as long as the
    // fullscreen did.
    return await endInstall(outcome.results, outcome.elapsedMs, {
      ...(entry === "install" ? { pruneFor: p } : {}),
    });
  }

  log.step(summary(p).split("\n")[0] ?? "");

  const { Reporter } = await import("./report.ts");
  const { converge } = await import("./converge.ts");
  const report = new Reporter();

  // The loop lives in converge.ts and emits events; this turns each one
  // into a line. The fullscreen view subscribes to the same events and
  // draws them instead — one ordering, one apt batch, one failure
  // policy, two presentations.
  let close:
    | ((outcome: StepOutcome, detail?: string, remedy?: string) => void)
    | null = null;
  const startedAt = Date.now();
  const summaryOf = await converge(
    { platform: p, ctx, scopes: scopes, dryRun: inv.dryRun },
    {
      scopeStart: (scope, total) => report.scope(scope, total),
      note: (message) => report.note(message),
      stepStart: (e) => {
        close = report.begin(e.tool, e.provider || "—");
      },
      stepEnd: (r) => {
        close?.(r.outcome, r.detail, r.remedy);
        close = null;
      },
    },
  );

  report.finish();

  return await endInstall(summaryOf.results, Date.now() - startedAt, {
    dryRun: inv.dryRun,
    ...(entry === "install" ? { pruneFor: p } : {}),
  });
}

/**
 * The last thing a converge puts on the terminal, and the status the
 * shell gets.
 *
 * It used to be one `ok` line under the summary, which is one more line
 * in a transcript of sixty — a run that took four minutes ended by
 * returning to a prompt, and whoever ran the one-liner had nothing
 * telling them it was over, whether it worked, or what to do next. So
 * this is a framed block instead: the verdict, what it cost, where the
 * run was written down, and the outstanding work as instructions.
 *
 * Shared by both presentations so they cannot disagree about what a run
 * was, and the status still comes from convergeExit so the third answer
 * stays stated once: 2 means every item that could run did, and the ones
 * that needed rights this run did not have are still waiting. Not 0,
 * because something is outstanding and a wrapper script has to be able
 * to see it; not 1, because nothing about this machine is broken.
 */
async function endInstall(
  items: readonly VerdictItem[],
  elapsedMs: number,
  options: { dryRun?: boolean; pruneFor?: Platform } = {},
): Promise<number> {
  const { completionBanner, convergeVerdict, shortenHome } = await import("./completion.ts");
  const { transcriptPath } = await import("./transcript.ts");
  const { convergeExit } = await import("./converge.ts");

  const verdict = convergeVerdict(items, elapsedMs, {
    logPath: shortenHome(transcriptPath(), process.env["HOME"] ?? process.env["USERPROFILE"]),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });

  // The versions nobody points at any more, before the banner so the
  // banner stays the last thing on the terminal.
  //
  // `install` did not prune, and `update` did only at the end of its own
  // walk — so a machine that was only ever re-installed, or whose
  // agents moved through `red-dev agents` and the mise `use -g` behind
  // it, kept every version it had ever been given: fifteen RedCodes and
  // 2.9 GB were measured on one. Every install now collects, and under
  // the same rule as the update's stage: after the converge, never
  // before it, because mise prunes what no config names and the config
  // is not final until the converge has had its say. Which is also why
  // a run with a failed item does not prune — a pin the converge failed
  // to write would read to mise as a tool nothing requires.
  //
  // `update` still prunes through its own stage, so the converge it
  // runs inside does not ask for this.
  if (options.pruneFor && options.dryRun !== true && verdict.counts.failed === 0) {
    const { misePruneSuite } = await import("./providers.ts");
    await misePruneSuite(options.pruneFor);
  }

  for (const line of completionBanner(verdict, process.stdout.columns ?? 72)) log.plain(line);

  // A failed run copies itself. The console this most often ends in
  // cannot be selected from — red-dev disables QuickEdit for the length
  // of the fullscreen view, because a mouse drag there pauses the
  // process — so the errors somebody is about to retype by hand are put
  // where they can be pasted instead. Nothing is copied on success.
  // See src/failure-clipboard.ts.
  const { copyFailures } = await import("./failure-clipboard.ts");
  const copied = await copyFailures(detect(), verdict, VERSION);
  if (copied) log.plain(`       ${copied}`);

  if (options.dryRun === true) return 0;
  return convergeExit({ failed: verdict.counts.failed, deferred: verdict.counts.deferred });
}

/**
 * The privileged remainder, and nothing else.
 *
 * The command a deferred converge points at. Declining the consent
 * prompt, or converging where nobody was there to answer one, leaves a
 * machine whose unprivileged half is entirely done — and re-running the
 * whole converge to reach the one item still outstanding is half an hour
 * spent repeating work that finished the first time.
 *
 * The loop does the work, under `only: "privileged"`, so this shares the
 * outcomes, the per-item rows, the transcript and the three exit codes
 * with the converge it is finishing. A second runner beside it would be
 * a second place for those to disagree, and they disagree about exactly
 * the thing an operator came here to settle.
 *
 * Nothing outstanding is a success. The question a script asks is
 * whether this machine is finished, and the answer does not depend on
 * whether it took a consent prompt to get there.
 */
async function cmdPrivileged(p: Platform, inv: Invocation): Promise<number> {
  if (windowsWsl(p)) return cmdInstall(p, { ...inv, scope: inv.scope ?? "core", yes: false });
  const { privilegedItems } = await import("./privileged.ts");
  const scopes = resolveScopes(p, inv.scope);
  const items = privilegedItems(p, scopes);

  // Answered before a context is built or the machine is probed. Every
  // Ubuntu target lands here — privileged work there goes through sudo,
  // which is its own path — and so does a Windows machine that already
  // consented once. A summary of nothing reads as a failure to do
  // something, so there is no summary.
  if (items.length === 0) {
    log.ok("nothing on this machine needs administrator");
    return 0;
  }

  const ctx = await contextFor(p, inv, "install");
  const { Reporter } = await import("./report.ts");
  const { converge, convergeExit } = await import("./converge.ts");
  const report = new Reporter();
  // Announced as its own scope rather than left to the converge's note:
  // this run has one subject, and the row counter needs a denominator
  // before the first item opens.
  report.scope("administrator", items.length);

  let close:
    | ((outcome: StepOutcome, detail?: string, remedy?: string) => void)
    | null = null;
  const summaryOf = await converge(
    { platform: p, ctx, scopes, dryRun: false, only: "privileged" },
    {
      note: (message) => report.note(message),
      stepStart: (e) => {
        close = report.begin(e.tool, e.provider || "—");
      },
      stepEnd: (r) => {
        close?.(r.outcome, r.detail, r.remedy);
        close = null;
      },
    },
  );
  report.finish();

  // The same three answers as a converge, and deliberately not the same
  // three sentences: "converged" would claim a whole machine on the
  // strength of one batch. A failure says nothing extra — the summary
  // has just named it, item by item.
  const code = convergeExit(summaryOf);
  if (code === 0) log.ok("the privileged work is done");
  else if (code === 2) {
    log.warn(
      summaryOf.deferred === 1
        ? "one item is still waiting on rights this run did not have"
        : `${summaryOf.deferred} items are still waiting on rights this run did not have`,
    );
  }
  return code;
}

/**
 * The phases mise's local plugin dispatches into, and the two a person
 * has a reason to type.
 *
 * Every one of them is the acquisition in src/red-skills-acquire.ts;
 * this is only the argv that reaches it. `list-all` and `latest-stable`
 * print to stdout because that is what mise parses, so they must not be
 * decorated — which is why the phase writes its answer through `out`
 * rather than through a step line.
 */
async function cmdRedSkills(p: Platform, inv: Invocation): Promise<number> {
  const { isPluginPhase, PLUGIN_PHASES, runPluginPhase } = await import("./red-skills-mise-plugin.ts");
  const phase = inv.redSkillsPhase ?? "install";

  // `sync` is red-dev's own, and is not one of the plugin's scripts on
  // purpose: a development checkout moves for reasons mise cannot see,
  // so nothing mise runs may advance one. See src/red-skills-checkout.ts.
  if (phase === "sync") return await cmdRedSkillsSync(p, inv);

  // `adopt` is red-dev's own for the same kind of reason: it removes
  // state, and nothing mise invokes on its own schedule may do that.
  if (phase === "adopt") return await cmdRedSkillsAdopt();

  // `watch` is what the triggers run: debounced, locked, and silent
  // unless something moved. Typed by a person it means "ask now", so
  // the interval is skipped — nobody types a command to be told it was
  // asked eleven minutes ago. See ADR 0017 and src/red-skills-watch.ts.
  if (phase === "watch") {
    const { watchRedSkills, announceWatch } = await import("./red-skills-watch.ts");
    const { triggerOf } = await import("./trigger.ts");
    const { interactive } = await import("./ui.ts");
    const { chosenPlugins } = await import("./red-skills-plugins.ts");
    const result = await watchRedSkills({
      manifestPlatform: p,
      activated: await chosenPlugins(p),
      force: inv.redSkillsSelector !== "due",
      // `force` used to be the only thing this line carried, and it
      // decides a debounce. What the converge downstream actually needs
      // to know is whether anybody is there — see src/trigger.ts.
      trigger: triggerOf(process.env, interactive()),
    });
    announceWatch(result);
    // The tick that asks about red-dev and RedSkills also keeps the list of
    // curated tools that are behind, which the desktop shows. Best effort,
    // and stamped inside, so most ticks touch nothing.
    if (inv.redSkillsSelector === "due") {
      try {
        const { refreshUpdateState } = await import("./update-state.ts");
        await refreshUpdateState(p);
      } catch {
        // Never let a bookkeeping failure fail the watch.
      }
    }
    return result.outcome === "refused" ? 1 : 0;
  }

  if (!isPluginPhase(phase)) {
    log.err(
      `unknown phase '${phase}' (expected: ${[...PLUGIN_PHASES, "sync", "adopt", "watch"].join(", ")})`,
    );
    return 1;
  }
  const { chosenPlugins } = await import("./red-skills-plugins.ts");
  const runPhase = async () => runPluginPhase(phase, {
    manifestPlatform: p,
    activated: await chosenPlugins(p),
    ...(inv.redSkillsSelector ? { selector: inv.redSkillsSelector } : {}),
  });
  if (phase === "list-all" || phase === "latest-stable") return runPhase();
  const { withUpdateLock } = await import("./update-coordinator.ts");
  const held = await withUpdateLock(runPhase);
  if (held.busy) { log.warn("another installation or update is running"); return 2; }
  return held.value;
}

/**
 * Adopt a workstation the standalone installer provisioned.
 *
 * Inventory, back up, and remove the obsolete half — in that order,
 * with the gate between the backup and the removal. Gated on what this
 * machine has *recorded*, which is what a reconciliation wrote down
 * when it verified each surface: a machine that has never converged
 * reports every host unverified and nothing is removed, which is the
 * correct answer and the one that names the command to run first.
 *
 * Non-zero when the gate refused, because this was asked for by name.
 * An operator who typed `adopt` and got a machine that adopted nothing
 * needs the exit code to say so.
 */
async function cmdRedSkillsAdopt(): Promise<number> {
  const { adoptLegacyWorkstation, announceAdoption } = await import("./red-skills-adopt.ts");
  const adoption = await adoptLegacyWorkstation();
  announceAdoption(adoption);
  if (adoption.outcome !== "held") return 0;
  log.plain("       run `red-dev red-skills reconcile` first, then this again");
  return 1;
}

/**
 * Sync one development checkout, and reconcile the hosts against it.
 *
 * The explicit operation the override requires: a content identity read
 * off the checkout, a digest-keyed staging built once and reused after,
 * and the same reconciliation stamp every other acquisition is gated on
 * — so a second sync with no edits in between writes nothing at all.
 */
async function cmdRedSkillsSync(p: Platform, inv: Invocation): Promise<number> {
  const { withUpdateLock } = await import("./update-coordinator.ts");
  const held = await withUpdateLock(() => cmdRedSkillsSyncUnlocked(p, inv));
  if (held.busy) { log.warn("another installation or update is running"); return 2; }
  return held.value;
}
async function cmdRedSkillsSyncUnlocked(p: Platform, inv: Invocation): Promise<number> {
  const dir = inv.redSkillsSelector;
  if (!dir) {
    log.err("red-skills sync needs the checkout to sync: `red-dev red-skills sync <path>`");
    return 1;
  }

  const { announceCheckout, syncRedSkillsCheckout } = await import("./red-skills-checkout.ts");
  const { reconcileRedSkills } = await import("./red-skills-acquire.ts");

  const { chosenPlugins } = await import("./red-skills-plugins.ts");
  const synced = await syncRedSkillsCheckout({
    dir,
    manifestPlatform: p,
    activated: await chosenPlugins(p),
  });
  announceCheckout(synced);
  if (synced.outcome === "refused") return 1;

  const reconciled = await reconcileRedSkills({ manifestPlatform: p });
  if (reconciled.reconciled) log.ok(`red-skills: ${reconciled.reason}`);
  else log.skip(`red-skills: ${reconciled.reason}`);
  return 0;
}

/**
 * Update the machine: the package managers, then everything they do not
 * own, then the converge that checks the result against the manifest.
 *
 * The order is declared in src/update-order.ts rather than written out
 * as a run of statements here, because it is the part of this that is
 * load-bearing and the part a reader has to be able to see whole. This
 * function is what each stage *is*; that file is what order they come
 * in and which of them may fail without ending the run.
 */
async function cmdUpdate(p: Platform, inv: Invocation): Promise<number> {
  if (inv.dryRun) return cmdUpdateUnlocked(p, inv);
  const { withUpdateLock, runUpdateJob } = await import("./update-coordinator.ts");
  const { autoUpdateMinutes } = await import("./auto-update-schedule.ts");
  let code = 0;
  const result = await withUpdateLock(async () => {
    await runUpdateJob("suite", autoUpdateMinutes() * 60_000, async () => { code = await cmdUpdateUnlocked(p, inv); return code === 0; }, { force: true });
    return code;
  });
  if (result.busy) { log.warn("another update is running; retry when it completes"); return 2; }
  return result.value;
}

async function cmdUpdateUnlocked(p: Platform, inv: Invocation, includeWsl = true): Promise<number> {
  if (!inv.dryRun) {
    const { runPendingMigrations } = await import("./migrations.ts");
    await runPendingMigrations(p);
  }

  const { runUpdate } = await import("./update-order.ts");

  // What the hourly timer runs (see src/auto-update-schedule.ts): the
  // stages mise owns and nothing that needs a person or a password.
  const skipUnattended = new Set<UpdateStage>(["system", "red-skills", "converge"]);
  const skipped = (stage: UpdateStage): boolean => inv.unattended && skipUnattended.has(stage);

  const stages: Record<UpdateStage, () => Promise<number | void>> = {
    system: () => systemUpdate(p, { whole: inv.system }),

    // Before the converge, because the converge builds out of this tree:
    // convergeRedSkills stops at "already wired", which is correct for
    // install and leaves the checkout frozen forever under update.
    "red-skills": async () => {
      if (inv.dryRun) return;

      // One staged reconciliation across acquisition, the seven hosts,
      // the companions and the exact workstation lock — and the same
      // one `mise upgrade red-skills` reaches through its postinstall.
      // That is what makes the two entry points end on one active
      // digest instead of two implementations that agree until they do
      // not, and it is where ADR 0010's Workers rule is applied: an
      // update that meets a running Worker stages the complete revision
      // and leaves this machine on the one that Worker is using.
      //
      // Carry partial reconciliation into the per-stage verdict even
      // when the ordinary converge finds all installed tools present.
      const { runStagedUpdate } = await import("./staged-update.ts");
      const { chosenPlugins } = await import("./red-skills-plugins.ts");
      const updated = await runStagedUpdate({ manifestPlatform: p, activated: await chosenPlugins(p) });

      const { updateRedSkills } = await import("./agents.ts");
      await updateRedSkills(p);
      if (updated.code !== 0) throw new Error("RedSkills update was partial; inspect red-dev doctor");
    },

    // The reddb-io suite, which until now no update path reached at all.
    //
    // apt and winget own their packages and upgrade them above; the
    // tools this organisation publishes were installed once by a release
    // download or a vendor script and then stayed at that version until
    // somebody re-ran the installer by hand. mise is what closes that,
    // and one `mise upgrade` covers every tool the generated fragment
    // declares rather than one call per tool.
    suite: async () => {
      if (inv.dryRun) return;
      const { miseUpgradeSuite } = await import("./providers.ts");
      await miseUpgradeSuite(p);
    },

    // The agent hosts, which mise does not own either — and which are
    // deliberately not handed to it. Each publisher updates its own.
    agents: async () => {
      if (inv.dryRun) return;
      // The workstation converge (or unattended child update) owns WSL's
      // complete update after ensuring the child is on this version.
      const code = await cmdAgentsUpdate(p, false, true);
      if (code !== 0) throw new Error("some agent hosts did not update");
    },

    // Upgrading can leave the manifest unsatisfied (a package removed, a
    // binary replaced), so always re-converge afterwards.
    converge: async () => {
      const { convergeUpdatedBinary } = await import("./update-handover.ts");
      return convergeUpdatedBinary(VERSION, inv, () => cmdInstallUnlocked(p, inv, "update"));
    },

    // And then the versions nobody points at any more, which nothing on
    // this machine collected before. Last, after the converge has
    // installed whatever the upgrade left unsatisfied: mise prunes what
    // no config names, and a prune before the converge would be reading
    // a config that is not final yet.
    prune: async () => {
      if (inv.dryRun) return;
      const { misePruneSuite } = await import("./providers.ts");
      await misePruneSuite(p);
    },
  };

  const run = await runUpdate(
    (stage) => stages[stage](),
    (stage, message, fatal) => {
      // A stage that may be walked past is a warning; one that ends the
      // update is the error that ended it.
      if (fatal) log.err(message);
      else log.warn(`${stage}: ${message}`);
    },
    { skip: skipped },
  );
  log.plain("\n[update result]");
  for (const result of run.results) {
    const detail = `${result.stage}: ${result.status}${result.detail ? ` — ${result.detail}` : ""}`;
    if (result.status === "ok") log.ok(detail);
    else log.warn(detail);
  }
  if (run.code === 3) log.warn("update was partial — inspect failed stages before retrying");
  if (windowsWsl(p) && includeWsl && inv.unattended && !inv.dryRun) {
    const { relayWslCommand, defaultDistroInfo, ensureDistroRedDev } = await import("./wsl-sync.ts");
    const distro = await defaultDistroInfo(p);
    if (!distro || await ensureDistroRedDev(distro.name) !== 0) return 3;
    if (await relayWslCommand(p, "red-dev maintenance") !== 0) return 3;
  }
  return run.code;
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

  // Record the decision before touching a surface. Redwall is repainted
  // by another process every two minutes, and that process reconstructs
  // its canvas from preferences; applying cobalt while leaving flare on
  // disk makes the switch last only until the next tick. Writing first
  // also closes the race where a tick fires halfway through this command.
  try {
    const { writePreferences } = await import("./preferences.ts");
    await writePreferences(p, { theme: chosen });
  } catch (err) {
    log.err(`theme preference: ${(err as Error).message}`);
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

async function cmdWallpaper(p: Platform, inv: Invocation, name?: string): Promise<number> {
  if (p.env === "server") {
    log.skip("wallpaper: no desktop on this machine");
    return 0;
  }

  const { readPreferences, resolveRedwall, writePreferences } = await import(
    "./preferences.ts"
  );
  const prefs = await readPreferences(p);
  const choices = ["theme", "current", ...themeNames(), "custom"] as [string, ...string[]];
  let chosen =
    name ??
    (await select(
      "Wallpaper? ('theme' follows the colour theme; 'current' keeps what the desktop shows; 'custom' imports an image)",
      choices,
      prefs.wallpaper && themeFor(prefs.wallpaper)
        ? prefs.wallpaper
        : prefs.wallpaper?.startsWith("custom:")
          ? "custom"
          : "theme",
    ));
  if (chosen === "custom") {
    if (!interactive()) {
      log.err("custom wallpaper needs an absolute image path or HTTPS URL");
      return 1;
    }
    chosen = await text("Absolute image path or HTTPS URL?");
  }

  const colourSlug = (await contextFor(p, inv, "theme")).theme;
  let preference: string | undefined;
  let label: string;
  if (chosen === "theme") {
    preference = undefined;
    label = `${colourSlug} (follows theme)`;
  } else if (chosen === "current") {
    // The image on the desktop today, kept as a managed import so the
    // colour theme can move without taking it along — and so Redwall
    // has PNG bytes to compose over. See keepCurrentWallpaper.
    try {
      const { keepCurrentWallpaper } = await import("./wallpaper.ts");
      const kept = await keepCurrentWallpaper(p);
      preference = kept.preference;
      label = kept.label;
    } catch (err) {
      log.err(`wallpaper: ${(err as Error).message}`);
      return 1;
    }
  } else if (themeFor(chosen)) {
    preference = chosen;
    label = chosen;
  } else {
    try {
      const { importCustomWallpaper } = await import("./wallpaper.ts");
      const imported = await importCustomWallpaper(chosen, p);
      preference = imported.preference;
      label = `custom image (${Math.ceil(imported.bytes / 1024)} KiB imported as PNG)`;
    } catch (err) {
      log.err(`wallpaper: ${(err as Error).message}`);
      return 1;
    }
  }

  if (await resolveRedwall(p)) {
    const { applyRedwall } = await import("./redwall.ts");
    const outcome = await applyRedwall(p, colourSlug, {}, preference ?? null);
    if (!outcome.shown) {
      log.warn("wallpaper selected, but the desktop refused the repaint");
      return 1;
    }
  } else {
    const { applyWallpaperPreference, sweepRetiredWallpapers } = await import("./wallpaper.ts");
    if (!(await applyWallpaperPreference(themeFor(colourSlug)!, colourSlug, preference, p))) {
      log.warn("wallpaper selected, but the desktop refused the repaint");
      return 1;
    }
    await sweepRetiredWallpapers(p);
  }

  await writePreferences(p, { wallpaper: preference });
  const { sweepCustomWallpapers } = await import("./wallpaper.ts");
  await sweepCustomWallpapers(p, preference);
  log.ok(`wallpaper: ${label}`);
  return 0;
}

/**
 * Regenerate this machine's Redwall.
 *
 * A command of its own rather than another thing `red-dev theme` does,
 * because it is fired by something outside the program — the RedSkills
 * daemon's host hook, on a Worker birth or death — and a command that
 * runs on somebody else's trigger must not be reachable only through one
 * a person types.
 *
 * The same command serves both callers, and `runRedwallHook` is what
 * tells them apart. Fired for a kind red-dev never declared, this
 * repaints nothing: the daemon fires only what the policy names, but
 * that policy is a file an operator edits, and a 4K compose on every
 * `worker-metrics` sample is a cadence nobody chose.
 *
 * Zero when the preference is off, and zero when there is no desktop
 * here. The trigger should not have to know which machine it is on or
 * what the user decided, and a non-zero exit for a feature nobody asked
 * for is an error line in a log about nothing.
 */
async function cmdRedwall(p: Platform): Promise<number> {
  const { applyRedwall } = await import("./redwall.ts");
  const { resolveWallpaperSlug } = await import("./preferences.ts");
  const { runRedwallHook } = await import("./redwall-hook.ts");

  // Generate AND repaint. This command exists so the hook can keep the
  // desktop current with no arguments and no knowledge of the
  // configuration — and a trigger that only manufactures PNGs while the
  // desktop stays pointed at last week's is the bug this command shipped
  // with. The resolved wallpaper is the right canvas here: it may follow
  // the theme or be independently pinned.
  let failure: Error | null = null;
  const run = await runRedwallHook(async () => {
    try {
      return await applyRedwall(p, await resolveWallpaperSlug(p));
    } catch (err) {
      // Composing failed, which is a real fault rather than a state: the
      // art, the face and the arithmetic all ship in this binary.
      failure = err as Error;
      return null;
    }
  });

  if (run.reason === "foreign-kind") {
    log.skip(`redwall: ${run.kind} is not a kind red-dev declared, so nothing was repainted`);
    return 0;
  }
  if (run.payload === "unrecognised") {
    // Said rather than swallowed. The repaint happened either way — the
    // state it draws is asked for after the event, never read off the
    // record — but a daemon speaking a host-state version this build
    // cannot read is why the image says the daemon is unavailable.
    log.warn(
      "redwall: the daemon's host-state document is a version this red-dev does not read — " +
        "repainting with what it can resolve for itself",
    );
  }
  if (failure !== null) {
    log.err(`redwall: ${(failure as Error).message}`);
    return 1;
  }
  const outcome = run.result!;

  if (outcome.skipped === "off") {
    log.skip("redwall is off — `red-dev menu` turns it on");
    return 0;
  }
  if (outcome.skipped === "headless") {
    log.skip("redwall: no desktop on this machine");
    return 0;
  }

  if (outcome.removed.length > 0) {
    log.plain(`       removed ${outcome.removed.length} superseded redwall(s)`);
  }
  // The path is what a person checks when a desktop shows something
  // unexpected; `shown` is whether they should need to. A desktop that
  // refused the repaint is worth a line, not an exit code — the next
  // tick retries, and a schedule must not accumulate red in a log over
  // a screen that was locked at the wrong moment.
  if (outcome.written) log.ok(`redwall: ${outcome.path}`);
  else log.ok(`redwall: ${outcome.path} (unchanged)`);
  if (!outcome.shown) log.warn("redwall: generated, but the desktop refused the repaint");
  return 0;
}

/**
 * The Catalogue — the list a person ticks rather than receives.
 *
 * Optional tools and web apps in one list, because they are the same
 * kind of thing to the person looking at it: something none of them gets
 * by converging, and all of them get by asking. A web app is the one
 * half whose entry can also be typed, so the list ends with a line that
 * asks for a URL.
 *
 * `install` stays silent on purpose — it runs in CI and in scripts,
 * where a prompt is a hang. Everything that wants an answer lives
 * behind a command you invoke deliberately, which is also why this can
 * be re-run whenever the answer changes.
 *
 * Unticking is what makes this a list rather than a form, and it now
 * means the same thing in both halves: anything installed arrives
 * ticked, so leaving the list alone changes nothing, and taking the tick
 * off something is how it goes — after being named, because the one
 * thing a checkbox must never do is delete something quietly.
 *
 * Which rows can be unticked into a removal, and which scopes are never
 * on this list at all, is src/catalogue.ts. This function is the
 * terminal around it: it asks, prints, and applies.
 */
async function cmdApps(p: Platform, inv: Invocation): Promise<number> {
  const { checkbox, confirm } = await import("./ui.ts");
  const {
    installedWebApps,
    installWebApp,
    removeWebApp,
    validateWebApp,
    webAppCatalogue,
    webAppSupport,
  } = await import("./webapps.ts");
  const {
    catalogueLines,
    catalogueRemovals,
    catalogueTools,
    removalNotice,
    removeUnticked,
  } = await import("./catalogue.ts");

  const tools = catalogueTools(p);

  // A page is offered only where a launcher has something to live in.
  // Under WSL that is nothing, and the reason is printed rather than the
  // section silently disappearing.
  const support = webAppSupport(p);
  const webApps = support.ok ? webAppCatalogue(installedWebApps(p)) : [];
  if (!support.ok) log.skip(`web apps: ${support.reason}`);

  if (tools.length === 0 && webApps.length === 0) {
    log.skip("nothing on this target is optional");
    return 0;
  }

  const lines = catalogueLines({ tools, webApps, canAdd: support.ok });
  const byLabel = new Map(lines.map((line) => [line.label, line]));
  const remoteApps = "Choose Ubuntu/WSL applications…";
  const labels = [...lines.map((line) => line.label), ...(windowsWsl(p) ? [remoteApps] : [])];
  const ticked = lines.filter((line) => line.ticked).map((line) => line.label);

  // Every install choice is opt-out, but a fallback must never install
  // the whole catalog when there is no terminal to show that choice —
  // and with removal on this list, a fallback answer is also an untick
  // nobody typed.
  if (!interactive()) {
    log.err("choosing what to install needs a terminal");
    log.plain("     Run `red-dev apps` interactively and untick what you do not want.");
    return 1;
  }

  const picked = await checkbox(
    "What should this machine have?",
    labels as [string, ...string[]],
    ticked,
  );
  const chosen = new Set(picked);

  // Named first and taken out first, so the list a person confirms is
  // the list they were looking at rather than one an install has already
  // changed underneath them.
  const going = catalogueRemovals(lines, chosen, {
    removeWeb: (name) => removeWebApp(p, name),
  });
  let failures = 0;

  if (going.length > 0) {
    log.plain("     Unticked, so these go:");
    for (const line of removalNotice(going)) log.plain(`       ${line}`);
    const outcome = await removeUnticked(going, confirm);
    if (!outcome.confirmed) log.skip("nothing removed");
    for (const line of outcome.done) log.ok(line);
    for (const failure of outcome.failed) {
      log.err(`${failure.name}: ${failure.reason}`);
      failures++;
    }
  }

  if (picked.length === 0) {
    if (going.length === 0) log.skip("nothing selected");
    return failures > 0 ? 1 : 0;
  }

  // Built on demand: an apply context prepares things a run of nothing
  // but web apps has no use for, and a person who ticked one page should
  // not pay for the install path they did not take.
  let context: ApplyContext | null = null;
  const installContext = async (): Promise<ApplyContext> =>
    (context ??= await contextFor(p, inv, "install"));

  for (const label of picked) {
    if (label === remoteApps) {
      const { relayWslCommand } = await import("./wsl-sync.ts");
      if (await relayWslCommand(p, "red-dev apps", {}, true) !== 0) failures++;
      continue;
    }
    const row = byLabel.get(label)?.row;
    if (!row) continue;

    if (row.kind === "tool") {
      const { tool, installed } = row.tool;
      if (installed && !tool.managed) {
        log.skip(`${tool.name} already present`);
        continue;
      }
      try {
        await applyProvider(providerFor(tool, p), await installContext());
        log.ok(tool.name);
      } catch (err) {
        log.err(`${tool.name}: ${(err as Error).message}`);
        failures++;
      }
      continue;
    }

    if (row.kind === "web") {
      // A URL added on Windows comes back from the Start Menu without
      // one, because a .lnk cannot say. Re-installing it would need a
      // URL we do not have, and it is already there.
      if (row.installed && row.app.url === "") continue;
      try {
        log.ok(`${row.app.name} — ${await installWebApp(p, row.app)}`);
      } catch (err) {
        log.err(`${row.app.name}: ${(err as Error).message}`);
        failures++;
      }
      continue;
    }

    const app = await askForWebApp(validateWebApp);
    if (!app) {
      log.skip("no URL given");
      continue;
    }
    try {
      log.ok(`${app.name} — ${await installWebApp(p, app)}`);
    } catch (err) {
      log.err(`${app.name}: ${(err as Error).message}`);
      failures++;
    }
  }

  return failures > 0 ? 1 : 0;
}

/**
 * The typed half of the web-app catalogue.
 *
 * Validated here rather than at the writer, so a typo is a question
 * asked again instead of a stack trace — and the icon is optional
 * because an internal page usually has no PNG anybody can name, and a
 * launcher wearing the generic icon still works.
 */
async function askForWebApp(
  check: (app: WebApp) => string | null,
): Promise<WebApp | null> {
  const url = (await text("URL? (https://…)")).trim();
  if (url === "") return null;
  const name = (await text("Name it?")).trim();
  if (name === "") return null;
  const iconUrl = (await text("PNG icon URL? (blank for none)")).trim();

  const app: WebApp = iconUrl === "" ? { name, url } : { name, url, icon: iconUrl };
  const problem = check(app);
  if (problem) {
    log.err(problem);
    return null;
  }
  return app;
}

/**
 * `red-dev keys` — every action, its chord, and whether this machine
 * binds it.
 *
 * Two shapes, and the plain one is not a degraded mode. A terminal that
 * cannot draw the viewer still gets the whole list with the reason on
 * every unbound row, which is the form a bug report pastes and a script
 * greps — and the form that proves nothing was hidden. The viewer adds
 * the search and the Enter key, not the information.
 */
async function cmdKeys(p: Platform): Promise<number> {
  const { keyEntries, keyLines } = await import("./keys.ts");
  const entries = keyEntries(p);

  if (!interactive()) {
    for (const line of keyLines(entries)) log.plain(line);
    return 0;
  }

  const { runKeysViewer } = await import("./keys-view.ts");
  await runKeysViewer(p, entries);
  return 0;
}

/**
 * `red-dev emoji` — the bundled table, searchable, with Enter on the
 * clipboard.
 *
 * Two shapes, and the plain one is not a degraded mode — the same rule
 * `red-dev keys` follows. A terminal that cannot draw the picker still
 * gets the whole table with the name, the group and the keywords on
 * every row, which is the form a script greps and the form that proves
 * the table ships with the binary rather than coming from the machine.
 * The picker adds the search and the copy, not the information.
 */
async function cmdEmoji(p: Platform): Promise<number> {
  const { emojiLines } = await import("./emoji.ts");

  if (!interactive()) {
    for (const line of emojiLines()) log.plain(line);
    return 0;
  }

  const { runEmojiPicker } = await import("./emoji-view.ts");
  await runEmojiPicker(p);
  return 0;
}

/**
 * `red-dev ssh [github-user]` — the way in that is not a first run.
 *
 * The interview asks this once, on a machine that is new. Everything
 * after that arrives here: a second person's keys, a machine converged
 * by `--yes`, a laptop where somebody answered no the first time. The
 * account name is a positional rather than a prompt so the command can
 * be typed in full, and asked for when it is missing.
 *
 * A terminal is required unless `--yes` says so in as many words. Every
 * ui.ts primitive answers with its fallback when there is nobody there,
 * so without this the command would print two fingerprints, silently
 * take the default no, and exit 0 having authorized nothing — which is
 * the failure this whole file exists to stop.
 */
async function cmdSsh(p: Platform, inv: Invocation): Promise<number> {
  const { askGithubUser, authorizeGithubKeys, rememberGithubUser, reportAuthorization } =
    await import("./ssh-access.ts");

  if (!inv.yes && !interactive()) {
    log.err("no terminal to confirm on — `red-dev ssh <github-user> --yes` authorizes unattended");
    return 1;
  }

  let user = inv.sshUser?.trim() ?? "";
  if (user === "") {
    user = await askGithubUser();
    if (user === "") {
      log.skip("nothing authorized");
      return 0;
    }
  }

  try {
    // `--yes` skips the question and nothing else: the keys are fetched
    // and their fingerprints printed either way, so an unattended run
    // still leaves a record of what it authorized.
    const result = await authorizeGithubKeys(user, inv.yes ? { confirm: async () => true } : {});
    reportAuthorization(p, result);
    await rememberGithubUser(p, result);
    return 0;
  } catch (err) {
    log.err(`ssh keys: ${(err as Error).message}`);
    return 1;
  }
}

/**
 * `red-dev learn` — the documentation, from inside the program.
 *
 * Picking a README section opens it at its heading where the machine
 * has something to open a link with, and prints the URL where it does
 * not: a headless server cannot browse, and a spawn that quietly fails
 * there would be worse than the address it could have copied.
 */
/**
 * `red-dev red-router [status|install|uninstall]`.
 *
 * The package owns its server and service contract. red-dev only
 * converges that contract and reports the endpoint agents use.
 */
async function cmdRouter(p: Platform, inv: Invocation): Promise<number> {
  if (windowsWsl(p)) return (await import("./wsl-sync.ts")).relayWslCommand(p, `red-dev red-router ${inv.routerVerb ?? "status"}`);
  const { inspectRouter, manageRouterService, routerHost, routerPort } = await import("./red-router.ts");
  const verb = inv.routerVerb;
  if (verb === "install" || verb === "uninstall") return await manageRouterService(p, verb);
  if (verb !== undefined && verb !== "status") {
    log.err(`unknown verb '${verb}' (expected: status, install, uninstall, or nothing for a report)`);
    return 1;
  }
  const checks = await inspectRouter(p);
  for (const check of checks) {
    const mark = check.status === "ok" ? log.ok : check.status === "drift" ? log.warn : log.skip;
    mark(`${check.name}: ${check.detail}`);
    if (check.fix) log.plain(`       fix: ${check.fix}`);
  }
  log.plain(`       endpoint for the agents: http://${routerHost()}:${routerPort()}/v1`);
  log.plain(`       dashboard: http://${routerHost()}:${routerPort()}/dashboard`);
  return checks.every((c) => c.status !== "drift") ? 0 : 1;
}

async function cmdLearn(p: Platform): Promise<number> {
  const { browseArgv, LEARN, learnLines } = await import("./learn.ts");

  if (!interactive()) {
    for (const line of learnLines()) log.plain(line);
    return 0;
  }

  const labels = LEARN.map((entry) => `${entry.label} — ${entry.detail}`);
  const picked = await select("Learn what?", labels as [string, ...string[]], labels[0]!);
  const entry = LEARN[labels.indexOf(picked)];
  if (!entry) return 0;

  // The one entry that is a surface rather than a link, and the reason
  // Learn is worth having beside the README: it answers "which key does
  // that" for the machine in front of you.
  if (entry.url === null) return await cmdKeys(p);

  const argv = browseArgv(entry.url, p, (cmd) => Bun.which(cmd));
  if (!argv) {
    log.plain(entry.url);
    return 0;
  }
  const { detach } = await import("./keys.ts");
  detach(argv);
  log.ok(entry.url);
  return 0;
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
    await resolveWorkstation(p);
    const { syncWslDistro } = await import("./wsl-sync.ts");
    await syncWslDistro(p);
    return 0;
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
    log.warn("This removes the shipped dotfiles, the ~/.bashrc hook, recorded preferences");
    log.warn("and the generated Redwall images.");
    log.plain("     Installed tools stay. Your pre-red-dev shell backup stays.");
    if (!(await confirm("Remove red-dev's configuration?", false))) {
      log.skip("nothing removed");
      return 0;
    }
    const removed = await removeConfiguration(p);
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
  // The Windows/WSL installer needs the console for OS setup and sudo.
  if (windowsWsl(p)) return cmdMenu(p, inv, buildCli().help());
  if (!interactive()) {
    log.err("the fullscreen interface needs a terminal");
    log.plain("     Use `red-dev` for the menu, or a command directly.");
    return 1;
  }

  // The bootstrap one-liner is an explicit installation entry. Warm sudo
  // before its first fullscreen frame; later bare `red-dev` launches are a
  // menu and must not demand a password merely to inspect a theme or doctor.
  if (process.env["RED_DEV_BOOTSTRAP"] === "1" && !inv.yes) {
    await prepareSudo(p, resolveScopes(p, inv.scope));
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
    case "wallpaper":
      return await cmdWallpaper(p, inv);
    case "installed":
      // The same three answers, and now the same closing block, as the
      // line report. A converge watched from the menu is still a
      // converge: a script that started this way reads the status the
      // same way, and a person who started this way is left holding the
      // same verdict on the terminal the interface handed back.
      return await endInstall(result.results ?? [], result.elapsedMs ?? 0);
    case "doctor":
      return await cmdDoctor(p, inv);
    case "network": {
      const { networkCommand } = await import("./network-diagnostics.ts");
      return await networkCommand(inv.json);
    }
    case "apps":
      return await cmdApps(p, inv);
    case "keys":
      // All three of these draw their own interface, so they run after
      // this one has released the screen — the same reason `apps` is
      // here rather than in the actions handed into the render.
      return await cmdKeys(p);
    case "emoji":
      return await cmdEmoji(p);
    case "learn":
      return await cmdLearn(p);
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
  const { AGENTS, availableAgents, currentAgentKeys, isAgentInstalled, isAgentReady, installAgent, installRedSkills } =
    await import("./agents.ts");
  const available = availableAgents(p);

  if (inv.agentDefault) return await cmdAgentsDefault(p, inv.agentDefaultKey);
  if (inv.agentRun) return await cmdAgentsRun(p, inv.passthrough);
  if (inv.agentUpdate) return await cmdAgentsUpdate(p);
  if (inv.agentPlugins) return await cmdAgentsPlugins(p, inv.agentPluginVerb, inv.agentPluginNames);

  if (inv.agentKeys !== undefined) {
    inv = { ...inv, agentKeys: currentAgentKeys(inv.agentKeys) };
  }

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
      // ask: false — this branch is the bridge into WSL and is
      // deliberately prompt-free, so a selection with a real choice in
      // it stays unanswered rather than being answered by a machine.
      await settleDefaultAgent(p, inv.agentKeys, false);
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
  // Ticked: what red-dev recommends, plus whatever is already here.
  // Everything else is another vendor's assistant, and a list that
  // arrives fully ticked installs the ones a managed machine forbids
  // for anybody who pressed enter. The Agents page in
  // src/tui-setup-model.ts makes the same choice for the same reason.
  const marked = labels.filter((_, i) => {
    const agent = available[i]!;
    return agent.recommended || isAgentInstalled(agent);
  });
  const picked = await checkbox("Which agents?", labels as [string, ...string[]], marked);
  if (picked.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  const keys = picked.map((l) => l.split(" ")[0]!);
  let failures = 0;

  const { writePreferences } = await import("./preferences.ts");
  await writePreferences(p, { agents: keys });
  await settleDefaultAgent(p, keys, true);

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
  const anyCli = keys.some((key) => available.some((agent) => agent.key === key));
  if (anyCli) {
    log.plain("");
    if (await confirm("Install red-skills for these agents?", true)) {
      try {
        await installRedSkills(p);
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

/**
 * Settle the Default agent for a selection that was just recorded.
 *
 * Silent when the selection holds one CLI host, because there is
 * nothing to decide. A question when it holds several — unless the
 * recorded answer is still one of them, in which case re-running
 * `red-dev agents` would be asking someone to repeat themselves.
 */
async function settleDefaultAgent(p: Platform, keys: string[], ask: boolean): Promise<void> {
  const { defaultAgentCandidates, impliedDefaultAgent } = await import("./default-agent.ts");
  const { readPreferences, writePreferences } = await import("./preferences.ts");

  const implied = impliedDefaultAgent(keys);
  if (implied) {
    await writePreferences(p, { defaultAgent: implied });
    return;
  }

  const candidates = defaultAgentCandidates(keys);
  if (candidates.length === 0) return;
  const recorded = (await readPreferences(p)).defaultAgent;
  if (candidates.some((agent) => agent.key === recorded)) return;

  if (!ask || !interactive()) {
    log.skip("more than one agent host — name the default: red-dev agents default <key>");
    return;
  }

  const { select } = await import("./ui.ts");
  const labels = candidates.map((agent) => `${agent.key} — ${agent.label}`);
  const picked = await select(
    "Which one does red-dev hand work to?",
    labels as [string, ...string[]],
    labels[0]!,
  );
  await writePreferences(p, { defaultAgent: picked.split(" ")[0]! });
}

/**
 * `red-dev agents plugins [names]` — report which RedSkills plugins the
 * hosts switch on, or choose again.
 *
 * The choice the interview made, reachable afterwards. Recording it is
 * not enough on its own: the activation config lives inside the
 * composed package set, so the set is recomposed — a different choice is
 * a different revision — and the hosts are reconciled against it, which
 * is what installs a plugin that was off or removes one that was on.
 * `none` is an answer too: a machine that wants the marketplace and no
 * plugin at all.
 */
async function cmdAgentsPlugins(
  p: Platform,
  verb: "add" | "remove" | "set" | undefined,
  names: string[] | undefined,
): Promise<number> {
  const { PLUGIN_CHOICES, PLUGIN_DEPENDENCIES, chosenPlugins, resolveActivatedPlugins } =
    await import("./red-skills-plugins.ts");
  const offered = PLUGIN_CHOICES.map((plugin) => plugin.key);

  if (verb === undefined || names === undefined) {
    const chosen = await chosenPlugins(p);
    const activated = await resolveActivatedPlugins(p);
    log.ok(`red-skills plugins: ${activated.join(", ") || "none"} switched on`);
    if (chosen.join(",") !== activated.join(",")) {
      log.plain(`       chosen ${chosen.join(", ") || "none"}; dependencies brought the rest along`);
    }
    for (const plugin of PLUGIN_CHOICES) {
      const on = activated.includes(plugin.key);
      log.plain(`     ${on ? "[x]" : "[ ]"} ${plugin.key} — ${plugin.note}`);
    }
    log.plain("     change it: red-dev agents plugins add memory | remove brain | dev,memory | none");
    return 0;
  }

  const unknown = names.filter((name) => !offered.includes(name));
  if (unknown.length > 0) {
    log.err(`unknown RedSkills plugin(s): ${unknown.join(", ")}`);
    log.plain(`     offered: ${offered.join(", ")}, or none`);
    return 1;
  }
  if ((verb === "add" || verb === "remove") && names.length === 0) {
    log.err(`red-dev agents plugins ${verb} needs plugin names: ${offered.join(", ")}`);
    return 1;
  }

  // `add` and `remove` edit the recorded choice; a list replaces it.
  // Removing a dependency removes what needs it as well — `remove dev`
  // is not a request to keep memory running without its foundation.
  const held = await chosenPlugins(p);
  let wanted: string[];
  if (verb === "add") {
    wanted = [...held, ...names.filter((name) => !held.includes(name))];
  } else if (verb === "remove") {
    const dropping = new Set(names);
    for (const name of held) {
      if ((PLUGIN_DEPENDENCIES[name] ?? []).some((dep) => dropping.has(dep))) dropping.add(name);
    }
    wanted = held.filter((name) => !dropping.has(name));
    const also = [...dropping].filter((name) => !names.includes(name) && held.includes(name));
    if (also.length > 0) log.plain(`       ${also.join(", ")} needs what is being removed, so it goes too`);
  } else {
    wanted = names;
  }
  wanted = offered.filter((name) => wanted.includes(name));
  for (const name of wanted) {
    const brought = (PLUGIN_DEPENDENCIES[name] ?? []).filter((dep) => !wanted.includes(dep));
    if (brought.length > 0) log.plain(`       ${name} needs ${brought.join(", ")}, which comes along`);
  }

  const { writePreferences } = await import("./preferences.ts");
  await writePreferences(p, { redSkillsPlugins: wanted });
  const activated = await resolveActivatedPlugins(p);
  log.ok(`red-skills plugins: ${activated.join(", ") || "none"} switched on`);

  // Recompose, then reconcile — the same two moves a converge makes,
  // in the same order, because the hosts are reconciled against the
  // set's digest and the activation config is part of that digest.
  const { convergeRedSkillsPackageSet } = await import("./red-skills-set.ts");
  const composed = convergeRedSkillsPackageSet({ manifestPlatform: p, activated: wanted });
  if (composed.refused) {
    log.warn(`red-skills package set: ${composed.refused.reason}`);
  }
  const { reconcileSkillHosts, stuckHosts } = await import("./red-skills-hosts.ts");
  const hosts = await reconcileSkillHosts(p);
  const restart = hosts.filter((host) => host.reload === "restart-needed").map((host) => host.host);
  if (restart.length > 0) log.plain(`       restart ${restart.join(", ")} to load the change`);
  const stuck = stuckHosts(hosts);
  if (stuck.length > 0) {
    log.warn(`red-skills: not reconciled in ${stuck.map((host) => host.host).join(", ")}`);
    return 1;
  }
  return 0;
}

/**
 * `red-dev agents default [key]` — report the recorded host, or record
 * a different one.
 *
 * Naming a host that is not installed is allowed and warned about
 * rather than refused: someone setting a machine up in the order they
 * choose is not making a mistake, and `doctor` says the same thing
 * afterwards until the host arrives.
 */
async function cmdAgentsDefault(p: Platform, key: string | undefined): Promise<number> {
  const { AGENTS, availableAgents, currentAgentKeys, isAgentInstalled, agentRunsHere } = await import(
    "./agents.ts"
  );
  const { isDefaultAgentCandidate, readDefaultAgent, reportDefaultAgent } = await import(
    "./default-agent.ts"
  );
  const { readPreferences, writePreferences } = await import("./preferences.ts");
  const offered = availableAgents(p).filter(isDefaultAgentCandidate);

  if (key === undefined) {
    const prefs = await readPreferences(p);
    const selected = AGENTS.find(a => a.key === prefs.defaultAgent);
    if (windowsWsl(p) && selected && !agentRunsHere(selected, p)) {
      return (await import("./wsl-sync.ts")).relayWslCommand(p, "red-dev agents default");
    }
    const report = reportDefaultAgent(
      readDefaultAgent(prefs.defaultAgent, isAgentInstalled),
      prefs.agents ?? [],
    );
    if (report.status === "ok") log.ok(report.detail);
    else if (report.status === "n/a") log.skip(report.detail);
    else log.err(report.detail);
    if (report.fix) log.plain(`       fix: ${report.fix}`);
    log.plain(`     hosts here: ${offered.map((agent) => agent.key).join(", ")}`);
    return report.status === "drift" ? 1 : 0;
  }

  const resolved = currentAgentKeys([key])[0];
  const spec = AGENTS.find((agent) => agent.key === resolved);
  if (!spec || !isDefaultAgentCandidate(spec)) {
    log.err(`'${key}' is not a host red-dev can hand work to`);
    log.plain(`     hosts here: ${offered.map((agent) => agent.key).join(", ")}`);
    return 1;
  }
  if (!offered.some((agent) => agent.key === spec.key)) {
    log.err(`${spec.label} has no installer for this side`);
    return 1;
  }

  await writePreferences(p, { defaultAgent: spec.key });
  log.ok(`default agent: ${spec.label}`);
  if (agentRunsHere(spec, p) && !isAgentInstalled(spec)) log.warn(`not installed yet — red-dev agents ${spec.key}`);
  if (windowsWsl(p) && !agentRunsHere(spec, p)) log.plain("     execution and installation are owned by Ubuntu/WSL");
  return 0;
}

/**
 * `red-dev agents run [-- args]` — start the Default agent.
 *
 * The terminal is handed over whole and nothing is printed on the way
 * in: the host draws its own interface, and a red-dev line above it
 * would be the last thing anyone wanted there. What it starts is the
 * plain invocation, built and checked in src/agent-launch.ts — the
 * command the person would have typed, plus whatever they typed after
 * `--`, and nothing else.
 */
async function cmdAgentsRun(p: Platform, passthrough: string[]): Promise<number> {
  const { commandPath } = await import("./agents.ts");
  const { resolveLaunch, runLaunchTarget } = await import("./agent-launch.ts");
  const { readPreferences } = await import("./preferences.ts");

  const prefs = await readPreferences(p);
  if (windowsWsl(p) && prefs.defaultAgent) {
    const { AGENTS, agentRunsHere } = await import("./agents.ts");
    const agent = AGENTS.find(a => a.key === prefs.defaultAgent);
    if (agent && !agentRunsHere(agent, p)) {
      const { relayWslCommand, wslCommand } = await import("./wsl-sync.ts");
      // Delegate the publisher's plain invocation with the user's exact arguments.
      return relayWslCommand(p, wslCommand([agent.cmd, ...passthrough]), {}, true);
    }
  }
  const decision = resolveLaunch(prefs, commandPath, passthrough);
  if (!decision.ok) {
    log.err(decision.detail);
    if (decision.fix) log.plain(`       fix: ${decision.fix}`);
    return 1;
  }

  try {
    return await runLaunchTarget(decision.target, p);
  } catch {
    log.err(`${decision.target.label} could not be started: ${decision.target.executable}`);
    return 1;
  }
}

/**
 * `red-dev agents update` — every installed host, by its own
 * publisher's mechanism.
 *
 * Deliberately not routed through the runtime manager's package
 * backend, and deliberately not one uniform path: see the header of
 * src/agent-update.ts. This surface is the reporting half of it — the
 * decisions all live there, so `red-dev update` running the same thing
 * as a stage cannot report it differently.
 */
async function cmdAgentsUpdate(p: Platform, includeWsl = true, coordinated = false): Promise<number> {
  if (!coordinated) {
    const { withUpdateLock } = await import("./update-coordinator.ts");
    const held = await withUpdateLock(() => cmdAgentsUpdate(p, includeWsl, true));
    if (held.busy) { log.warn("another update is running"); return 2; }
    return held.value;
  }
  const { availableAgents, agentRunsHere } = await import("./agents.ts");
  const { reportAgentUpdate, updateAgents } = await import("./agent-update.ts");

  const hosts = availableAgents(p).filter(a => agentRunsHere(a, p));
  log.step(`agents: updating ${hosts.length} known hosts, each by its publisher`);
  const outcomes = await updateAgents(hosts, p, { report: reportAgentUpdate });

  const failed = outcomes.filter((outcome) => outcome.state === "failed");
  const remoteCode = windowsWsl(p) && includeWsl
    ? await (await import("./wsl-sync.ts")).relayWslCommand(p, "red-dev agents update") : 0;
  const updated = outcomes.filter((outcome) => outcome.state === "updated").length;
  // Counted rather than narrated: a machine where nothing moved is the
  // ordinary result of running this twice, and it should read like one.
  if (failed.length === 0) {
    log.ok(updated === 0 ? "every agent host was already current" : `${updated} agent host(s) updated`);
    return remoteCode === 0 ? 0 : 1;
  }
  log.err(`${failed.length} agent host(s) failed: ${failed.map((f) => f.key).join(", ")}`);
  return 1;
}

/** Choose which language runtimes mise manages. */
async function cmdLang(p: Platform, inv: Invocation): Promise<number> {
  const { checkbox } = await import("./ui.ts");
  const {
    OFFERED_RUNTIMES,
    useRuntimes,
    currentRuntimes,
    resolveRuntimeIds,
    runtimeIdsForPolicy,
    runtimeSelectedByDefault,
  } =
    await import("./runtimes.ts");

  let ids = inv.runtimeIds;
  if (ids !== undefined) {
    // Every runtime red-dev owns is a moving channel. A selector accepted
    // for backwards compatibility is normalised to latest as well.
    const resolved = resolveRuntimeIds(ids, inv.latest ? "latest" : "recommended");
    ids = resolved.ids;
    const { unknown } = resolved;
    if (unknown.length > 0) {
      log.err(`unknown runtime(s): ${unknown.join(", ")}`);
      log.plain(
        `     known runtime names: ${OFFERED_RUNTIMES.map((runtime) => runtime.id.split("@")[0]).join(", ")}`,
      );
      log.plain("     use a runtime name such as node, or its @latest selector");
      return 1;
    }
  } else {
    if (!interactive()) {
      log.err("choosing runtimes needs a terminal");
      log.plain("     For unattended installs, name them explicitly:");
      log.plain("       red-dev lang --latest node,bun");
      return 1;
    }

    const current = await currentRuntimes();
    const labels = OFFERED_RUNTIMES.map((r) => {
      const name = r.id.split("@")[0]!;
      return `${r.id} — ${r.about}${current.includes(name) ? "  (installed)" : ""}`;
    });

    const picked = await checkbox(
      "Which runtimes?",
      labels as [string, ...string[]],
      labels.filter((label) => runtimeSelectedByDefault(label.split(" ")[0]!)),
    );
    ids = picked.map((label) => label.split(" ")[0]!.trim());

    ids = runtimeIdsForPolicy(ids, "latest");
  }

  if (ids.length === 0) {
    log.skip("nothing selected");
    return 0;
  }

  let failures = 0;
  try {
    if (!windowsWsl(p)) await useRuntimes(ids, {
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

  if ((process.stdout.columns ?? 0) >= 60 && !windowsWsl(p)) {
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
    keys: () => cmdKeys(p),
    emoji: () => cmdEmoji(p),
    learn: () => cmdLearn(p),
    lang: () => cmdLang(p, inv),
    shell: () => cmdShell(p, inv),
    uninstall: () => cmdUninstall(p),
    applyTheme: (name) => cmdTheme(p, inv, name),
    applyWallpaper: (name) => cmdWallpaper(p, inv, name),
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
 * Write the crash down, then offer it to the Default agent.
 *
 * The capture is synchronous and comes first, because it is the half
 * that has to survive: an async write loses the race with process death
 * on Windows, where the window closing is the whole reason the file
 * exists. Everything after it is a courtesy — a machine with no Default
 * agent, or one whose owner declined the offer, exits here exactly as
 * it did before crash-handoff.ts existed.
 *
 * The exit is deferred until the offer settles, and only until then. A
 * handed-off crash means the person is now inside the agent, and the
 * process that crashed is waiting to release the terminal back to them.
 */
async function endWithCrash(kind: string, err: unknown): Promise<never> {
  const capture = recordCrash(kind, err, { version: VERSION });
  try {
    const { handOffCrash } = await import("./crash-handoff.ts");
    await handOffCrash(capture, VERSION);
  } catch {
    // A failure while offering must not replace the crash that is
    // already on disk with one about the offer.
  }
  process.exit(70);
}

if (process.argv[2] !== "statusline") {
  process.on("uncaughtException", (err) => {
    void endWithCrash("uncaughtException", err);
  });
  process.on("unhandledRejection", (err) => {
    void endWithCrash("unhandledRejection", err);
  });
}

async function main(): Promise<number> {
  if (typeof Bun === "undefined") {
    log.err("red-dev runs on bun — use the binary in ~/.local/bin, or `bun run src/main.ts ...` from the checkout; under node the source crashes before any command");
    return 1;
  }
  const cli = buildCli();
  const argv = process.argv.slice(2);
  // Everything after `--` is meant for the program red-dev starts, so
  // it is not scanned for red-dev's own flags either: `agents run --
  // --help` asks the agent for its help, not red-dev for ours.
  const separator = argv.indexOf("--");
  const ours = separator >= 0 ? argv.slice(0, separator) : argv;

  // Handled before parsing: the schema runs in strict mode, so an
  // undeclared --help would be rejected as an unknown option before we
  // ever got the chance to honour it. Declaring them as real options
  // would instead make them appear in every command's option list,
  // which is noise.
  if (ours.includes("--version") || ours.includes("-V")) {
    log.plain(VERSION);
    return 0;
  }
  if (ours.includes("--help") || ours.includes("-h")) {
    const verb = ours.find((a) => !a.startsWith("-"));
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

  const { resolveWorkstation } = await import("./workstation.ts");
  const p = await resolveWorkstation(detect());

  switch (inv.command) {
    case "platform":
      return cmdPlatform(p);
    case "plan":
      return await cmdPlan(p, inv);
    case "doctor":
      return await cmdDoctor(p, inv);
    case "network": {
      const { networkCommand } = await import("./network-diagnostics.ts");
      return await networkCommand(inv.json);
    }
    case "statusline": {
      const { statuslineCommand } = await import("./statusline-command.ts");
      return await statuslineCommand();
    }
    case "desktop": {
      // Old mise fragments invoke only desktop reconcile after moving red-dev.
      // Retire the old resource controls during that existing upgrade hook too.
      if (inv.desktopVerb === "reconcile" && process.env["MISE_TOOL_INSTALL_PATH"]) {
        const { convergeBuildResources } = await import("./build-resources.ts");
        await convergeBuildResources(p);
      }
      const { desktopCommand } = await import("./desktop.ts");
      return await desktopCommand(p, inv.desktopVerb ?? "status");
    }
    case "rescue":
      return await cmdRescue(p, inv);
    case "reclaim":
      return await cmdReclaim(p, inv);
    case "logs":
      return await cmdLogs(inv);
    case "install":
      return await cmdInstall(p, inv);
    case "update":
      return await cmdUpdate(p, inv);
    case "maintenance": {
      const { runMaintenance } = await import("./maintenance.ts");
      return runMaintenance(p, {
        update: () => cmdUpdateUnlocked(p, { ...inv, unattended: true, yes: true }, false),
        ...(windowsWsl(p) ? { remote: async () => {
          const { relayWslCommand, defaultDistroInfo, ensureDistroRedDev } = await import("./wsl-sync.ts");
          const distro = await defaultDistroInfo(p);
          if (!distro || await ensureDistroRedDev(distro.name) !== 0) return 3;
          return relayWslCommand(p, "red-dev maintenance");
        } } : {}),
      });
    }
    case "policy": {
      const { policyCommand } = await import("./policy-command.ts");
      return policyCommand(p, inv.policyTool, inv.policyMode, inv.policyVersion);
    }
    case "privileged":
      return await cmdPrivileged(p, inv);
    case "theme":
      return await cmdTheme(p, inv, inv.scope);
    case "wallpaper":
      return await cmdWallpaper(p, inv, inv.wallpaperName);
    case "redwall":
      return await cmdRedwall(p);
    case "apps":
      return await cmdApps(p, inv);
    case "keys":
      return await cmdKeys(p);
    case "emoji":
      return await cmdEmoji(p);
    case "ssh":
      return await cmdSsh(p, inv);
    case "learn":
      return await cmdLearn(p);
    case "red-skills":
      return await cmdRedSkills(p, inv);
    case "red-router":
      return await cmdRouter(p, inv);
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
async function cmdLogs(inv: Invocation): Promise<number> {
  const { logsCommand } = await import("./diagnostic-logs.ts");
  return await logsCommand(inv);
}

/**
 * Run, and write down what happened.
 *
 * Wrapped around main rather than inside it so a throw is transcribed
 * too — the run that ends in a stack trace is the one most worth having
 * a log of, and a try/finally is the only way to be sure the exit line
 * is written on every path out.
 *
 * Read-only commands bypass this wrapper so observability cannot create log
 * pressure. Mutating commands retain the durable trace needed for diagnosis.
 */
async function run(): Promise<number> {
  const argv = process.argv.slice(2);
  // Claude invokes this frequently. A statusline must never create a transcript.
  if (argv[0] === "statusline") {
    try {
      return await main();
    } catch {
      // A cosmetic producer must not write crash evidence or disturb Claude.
      return 0;
    }
  }
  // Inspection really is read-only: repeated health checks and previews must
  // not manufacture the very log pressure they are intended to diagnose.
  const verb = argv[0];
  if (
    verb === "doctor" ||
    verb === "network" ||
    verb === "logs" ||
    (verb === "desktop" && (argv[1] === undefined || argv[1] === "status")) ||
    ((verb === "rescue" || verb === "reclaim") && !argv.includes("--apply")) ||
    argv.includes("--help") ||
    argv.includes("-h") ||
    argv.includes("--version") ||
    argv.includes("-V")
  ) return await main();

  const { startTranscript, finishTranscript } = await import("./transcript.ts");
  const command = argv.join(" ") || "menu";
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
    if (path && code !== 0 && !argv.some(arg => /^--json(?:=true)?$/.test(arg))) log.plain(`       log: ${path}`);
  }
}

process.exit(await run());
