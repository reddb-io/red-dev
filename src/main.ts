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
import { transcriptDir } from "./transcript.ts";
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
  return 0;
}

async function cmdDoctor(p: Platform, inv: Invocation): Promise<number> {
  let missing = 0;
  let outdated = 0;
  let mismatched = 0;
  let hostProblems = 0;
  const livePids = new Set<number>();

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

  log.plain("\n[host]");
  if (p.os === "linux") {
    const [{ collectLinuxHostSnapshot }, { inspectStatuslineHealth }, { buildHostReport }, { assessHost }] =
      await Promise.all([
        import("./linux-host.ts"),
        import("./statusline-health.ts"),
        import("./host-report.ts"),
        import("./host-health.ts"),
      ]);
    // Probe first and collect second: the bounded probe must not appear in
    // the very process census it is validating.
    const statusline = await inspectStatuslineHealth();
    const snapshot = await collectLinuxHostSnapshot();
    for (const process of snapshot.processes) livePids.add(process.pid);
    log.ok(
      `${snapshot.metrics.processCount.toLocaleString("en-US")} processes, ` +
        `${snapshot.metrics.taskCount.toLocaleString("en-US")} tasks`,
    );
    if (snapshot.workerStateKnown) {
      log.ok(`${snapshot.workers.length} Worker(s) registered by redskilled`);
    } else {
      log.skip("Worker state unknown — daemon absent or protocol not understood");
    }
    if (snapshot.metrics.workerMemoryMax.length > 0) {
      const current = snapshot.metrics.workerMemoryCurrent.reduce((sum, bytes) => sum + bytes, 0);
      const limits = snapshot.metrics.workerMemoryMax.map((limit) =>
        limit === "infinity" ? limit : `${(limit / 1024 ** 3).toFixed(1)} GiB`
      );
      log.ok(
        `Worker memory isolation: ${(current / 1024 ** 3).toFixed(1)} GiB current; ` +
          `MemoryMax ${limits.join(", ")}`,
      );
    }

    const report = buildHostReport(snapshot, statusline);
    hostProblems = report.problems;
    for (const row of report.rows) {
      const detail = `${row.name} — ${row.detail}`;
      if (row.kind === "ok") log.ok(detail);
      else if (row.kind === "skip") log.skip(detail);
      else if (row.kind === "warning") log.warn(detail);
      else log.err(detail);
      if (row.fix) log.plain(`       fix: ${row.fix}`);
    }

    for (const group of assessHost(snapshot).groups.filter((item) => item.disposition === "suspect")) {
      log.skip(`suspect group ${group.pgid} (${group.pids.join(",")}) — ${group.reasons.join(", ")}`);
    }
  } else {
    log.skip("online process health is available on Linux and WSL");
  }

  const reclaim = await import("./reclaim.ts");
  const crashDumpDir = p.os === "windows" || p.env === "wsl"
    ? await reclaim.windowsCrashDumpDir()
    : null;
  const artifacts = reclaim.collectArtifactUsage(reclaim.redDevStateRoot(), crashDumpDir);
  const reclaimPlan = reclaim.collectReclaimPlan({
    stateRoot: reclaim.redDevStateRoot(),
    includeCrashDumps: crashDumpDir !== null,
    crashDumpDir,
    livePids,
  });
  const selectedKinds = new Set(reclaimPlan.items.map((item) => item.kind));
  const artifactRows = [
    ["transcripts", artifacts.transcripts, "transcript"],
    ["zellij crashes", artifacts.zellijCrashes, "zellij-crash"],
    ["red-dev crashes", artifacts.redDevCrashes, "red-dev-crash"],
    ["Windows CrashDumps", artifacts.windowsDumps, "windows-dump"],
  ] as const;
  for (const [name, usage, kind] of artifactRows) {
    const detail = `${usage.count} file(s), ${reclaim.formatBytes(usage.bytes)}`;
    if (selectedKinds.has(kind)) {
      log.warn(`${name} — ${detail}`);
      log.plain(
        `       fix: red-dev reclaim${name === "Windows CrashDumps" ? " --crash-dumps" : ""}`,
      );
      hostProblems++;
    } else {
      log.ok(`${name} — ${detail}`);
    }
  }

  if (p.os === "windows" || p.env === "wsl") {
    const disk = await reclaim.windowsDiskUsage();
    if (disk) {
      const ratio = disk.freeBytes / disk.totalBytes;
      const freeGiB = disk.freeBytes / 1024 ** 3;
      const detail = `C: ${reclaim.formatBytes(disk.freeBytes)} free`;
      if (ratio < 0.05 || freeGiB < 10) {
        log.err(detail);
        hostProblems++;
      } else if (ratio < 0.15 || freeGiB < 20) {
        log.warn(detail);
        hostProblems++;
      } else {
        log.ok(detail);
      }
    } else {
      log.skip("Windows C: capacity unavailable");
    }
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
      } else if (installState(tool) === "mismatched") {
        // Deliberately not phrased as old or new: this is the one case
        // where the machine may be ahead of where it must be, and the
        // remedy is the pinned release either way.
        const found = installedVersion(tool) ?? "unknown";
        log.err(`${tool.name} ${found} — pinned to ${tool.pinVersion} (${describeProvider(pr)})`);
        mismatched++;
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
  if (missing > 0 || outdated > 0 || mismatched > 0 || drifted > 0 || hostProblems > 0) {
    const parts = [`${missing} tool(s) missing`];
    if (outdated > 0) parts.push(`${outdated} outdated`);
    if (mismatched > 0) parts.push(`${mismatched} off the pinned version`);
    parts.push(`${drifted} config drift(s)`);
    if (hostProblems > 0) parts.push(`${hostProblems} host health problem(s)`);
    log.warn(parts.join(", "));
    return 1;
  }
  log.ok("no drift");
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
  const { transcriptPath } = await import("./transcript.ts");
  let workerStateKnown = false;
  let workers = 0;
  const livePids = new Set<number>();
  if (p.os === "linux") {
    const { collectLinuxHostSnapshot } = await import("./linux-host.ts");
    const snapshot = await collectLinuxHostSnapshot();
    workerStateKnown = snapshot.workerStateKnown;
    workers = snapshot.workers.length;
    for (const process of snapshot.processes) livePids.add(process.pid);
  } else if (p.os === "windows") {
    const { readPreferences } = await import("./preferences.ts");
    const gate = await reclaim.windowsWslWorkerState((await readPreferences(p)).distro);
    workerStateKnown = gate.known;
    workers = gate.workers;
  }

  const current = transcriptPath();
  const crashDumpDir = inv.crashDumps ? await reclaim.windowsCrashDumpDir() : null;
  const plan = reclaim.collectReclaimPlan({
    stateRoot: reclaim.redDevStateRoot(),
    includeCrashDumps: inv.crashDumps,
    crashDumpDir,
    livePids,
    protectedPaths: new Set(current ? [current] : []),
  });

  log.plain("\n[reclaim]");
  if (inv.crashDumps && crashDumpDir === null) {
    log.warn("Windows CrashDumps could not be reached; none are in this plan");
  }
  if (plan.items.length === 0) {
    log.ok("all derived artifacts are within their retention budgets");
    return 0;
  }
  log.warn(`${plan.items.length} derived file(s), ${reclaim.formatBytes(plan.bytes)} reclaimable`);
  for (const item of plan.items) {
    log.plain(
      `  ${item.kind.padEnd(15)} ${reclaim.formatBytes(item.file.size).padStart(10)}  ` +
        `${item.file.path} — ${item.reasons.join(", ")}`,
    );
  }

  if (!inv.apply) {
    const crash = inv.crashDumps ? " --crash-dumps" : "";
    log.plain(`\nPreview only. Apply exactly this plan with: red-dev reclaim --apply${crash}`);
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
  if (!interactive() && !inv.yes) {
    log.err("non-interactive Reclaim requires both --apply and --yes");
    return 1;
  }
  if (interactive() && !inv.yes) {
    const { confirm } = await import("./ui.ts");
    if (!(await confirm(`Remove ${plan.items.length} derived file(s)?`, false))) {
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
  log.ok(`reclaimed ${reclaim.formatBytes(result.removedBytes)}`);
  return result.skipped.length > 0 || result.failed.length > 0 ? 1 : 0;
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
    const { convergeExit } = await import("./converge.ts");
    const outcome = await runInstallTui({ platform: p, ctx, scopes });
    return endInstall(convergeExit(outcome), outcome.deferred);
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

  if (inv.dryRun) {
    log.ok("dry run — nothing changed");
    return 0;
  }
  const { convergeExit } = await import("./converge.ts");
  return endInstall(convergeExit(summaryOf), summaryOf.deferred);
}

/**
 * The last line of a converge, and the status the shell gets.
 *
 * Shared by both presentations so they cannot disagree about what a run
 * was, and separate from either so the third answer is stated once: 2
 * means every item that could run did, and the ones that needed rights
 * this run did not have are still waiting. Not 0, because something is
 * outstanding and a wrapper script has to be able to see it; not 1,
 * because nothing about this machine is broken.
 */
function endInstall(code: 0 | 1 | 2, deferred = 0): number {
  if (code === 0) log.ok("converged — restart your shell");
  else if (code === 2) {
    log.warn(
      deferred === 1
        ? "converged, except one item that needs rights this run did not have"
        : `converged, except ${deferred} items that need rights this run did not have`,
    );
  }
  return code;
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
 * Regenerate this machine's Redwall.
 *
 * A command of its own rather than another thing `red-dev theme` does,
 * because it is fired by something outside the program — a state change
 * the RedSkills daemon reports — and a command that runs on its own
 * schedule must not be reachable only through one a person types.
 *
 * Zero when the preference is off, and zero when there is no desktop
 * here. The trigger should not have to know which machine it is on or
 * what the user decided, and a non-zero exit for a feature nobody asked
 * for is an error line in a log about nothing.
 */
async function cmdRedwall(p: Platform): Promise<number> {
  const { applyRedwall } = await import("./redwall.ts");
  const { readPreferences } = await import("./preferences.ts");
  const { resolveThemeSlug } = await import("./themes.ts");

  // Generate AND repaint. This command exists so a schedule or a hook
  // can keep the desktop current with no arguments and no knowledge of
  // the configuration — and a schedule that only manufactures PNGs
  // while the desktop stays pointed at last week's is the bug this
  // command shipped with. The recorded theme is the right canvas here:
  // unlike `red-dev theme`, nothing is being switched away from.
  let outcome: Awaited<ReturnType<typeof applyRedwall>>;
  try {
    const slug = resolveThemeSlug((await readPreferences(p)).theme);
    outcome = await applyRedwall(p, slug);
  } catch (err) {
    // Composing failed, which is a real fault rather than a state: the
    // art, the face and the arithmetic all ship in this binary.
    log.err(`redwall: ${(err as Error).message}`);
    return 1;
  }

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
    case "installed": {
      // The same three answers as the line report. A converge watched
      // from the menu is still a converge, and a script that started
      // this way reads the status the same way.
      const { convergeExit } = await import("./converge.ts");
      const deferred = result.deferred ?? 0;
      return endInstall(convergeExit({ failed: result.failed ?? 0, deferred }), deferred);
    }
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
  const dir = transcriptDir();
  const path = `${dir}/crash.log`;
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

if (process.argv[2] !== "statusline") {
  process.on("uncaughtException", (err) => {
    recordCrash("uncaughtException", err);
    process.exit(70);
  });
  process.on("unhandledRejection", (err) => {
    recordCrash("unhandledRejection", err);
    process.exit(70);
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
      return await cmdPlan(p, inv);
    case "doctor":
      return await cmdDoctor(p, inv);
    case "statusline": {
      const { statuslineCommand } = await import("./statusline-command.ts");
      return await statuslineCommand();
    }
    case "rescue":
      return await cmdRescue(p, inv);
    case "reclaim":
      return await cmdReclaim(p, inv);
    case "logs":
      return await cmdLogs(inv.logsWhich);
    case "install":
      return await cmdInstall(p, inv);
    case "update":
      return await cmdUpdate(p, inv);
    case "privileged":
      return await cmdPrivileged(p, inv);
    case "theme":
      return await cmdTheme(p, inv, inv.scope);
    case "redwall":
      return await cmdRedwall(p);
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
    if (path && code !== 0) log.plain(`       log: ${path}`);
  }
}

process.exit(await run());
