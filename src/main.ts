#!/usr/bin/env bun
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
  return 0;
}

async function cmdDoctor(p: Platform, inv: Invocation): Promise<number> {
  let missing = 0;
  let outdated = 0;
  let mismatched = 0;
  let shadowedCount = 0;
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

  // Presence on PATH is the easy half — and "present" is not the same
  // as "the one that runs". A tool moved to mise was installed some
  // other way first, and nothing removed that copy; whichever comes
  // first on PATH wins, so an upgrade can succeed against a binary
  // nobody executes.
  {
    const { describeShadowed, findShadowed, pathLookup } = await import("./shadowed.ts");
    const { miseInstallRoot } = await import("./mise-config.ts");
    const shadowed = findShadowed(
      p,
      (name) => pathLookup(name),
      resolveScopes(p, inv.scope).flatMap((scope) => toolsInScope(scope)),
      miseInstallRoot(),
    );
    for (const row of describeShadowed(shadowed)) {
      log.warn(`${row.name} — ${row.detail}`);
      if (row.fix) log.plain(`       fix: ${row.fix}`);
      shadowedCount++;
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

  // The RedSkills package set this machine resolves: which revision,
  // whether anything vouches for it, what it would roll back to, and
  // why the last candidate was turned away. Read from the state the
  // converge wrote — nothing here recomposes or re-verifies anything.
  log.plain("\n[red-skills]");
  const { redSkillsSetReport, redSkillsSetRows } = await import("./red-skills-set.ts");
  const setHome = (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");
  let setProblems = 0;
  for (const row of redSkillsSetRows(redSkillsSetReport(setHome))) {
    if (row.status === "ok") log.ok(row.detail);
    else if (row.status === "n/a") log.skip(row.detail);
    else if (row.status === "warn") log.warn(row.detail);
    else {
      log.err(row.detail);
      setProblems++;
    }
  }

  // And what each of the seven hosts was observed to have: the set digest
  // it was reconciled against, the mechanism it was reached through, the
  // digest of the state that reconciliation owns, and whether a session
  // that was up still has to be restarted to load it. Every one of those
  // was read off the machine at the time it was recorded, which is the
  // whole difference from the refresh stamp this replaced.
  const { redSkillsHostReport, redSkillsHostRows } = await import("./red-skills-hosts.ts");
  for (const row of redSkillsHostRows(redSkillsHostReport(setHome))) {
    if (row.status === "ok") log.ok(row.detail);
    else if (row.status === "n/a") log.skip(row.detail);
    else log.warn(row.detail);
  }

  // The machine's agent posture, in the one place that already answers
  // "is this machine ready": which host red-dev hands work to, how old
  // each installed host's copy is, and the per-provider allowance detail
  // the Redwall's single line has no room for. Every row is read from
  // what some other run wrote down — nothing here probes a provider,
  // starts a host or writes a preference.
  log.plain("\n[agents]");
  const { agentPostureFor } = await import("./agent-posture.ts");
  let agentProblems = 0;
  for (const row of await agentPostureFor(p)) {
    const detail = `${row.name} — ${row.detail}`;
    if (row.status === "ok") log.ok(detail);
    else if (row.status === "n/a") log.skip(detail);
    else {
      log.err(detail);
      agentProblems++;
    }
    if (row.fix) log.plain(`       fix: ${row.fix}`);
  }

  log.plain("");
  if (
    missing > 0 || outdated > 0 || mismatched > 0 || drifted > 0 || hostProblems > 0 ||
    shadowedCount > 0 || agentProblems > 0 || setProblems > 0
  ) {
    const parts = [`${missing} tool(s) missing`];
    if (outdated > 0) parts.push(`${outdated} outdated`);
    if (mismatched > 0) parts.push(`${mismatched} off the pinned version`);
    // Counted, because the whole point is that this one is invisible
    // otherwise: every other check passes while the command you run is
    // not the command that was updated. It stays a warning rather than
    // an error — the remedy is a person deciding which copy to delete,
    // not a converge.
    if (shadowedCount > 0) parts.push(`${shadowedCount} shadowed by another copy on PATH`);
    parts.push(`${drifted} config drift(s)`);
    if (hostProblems > 0) parts.push(`${hostProblems} host health problem(s)`);
    if (agentProblems > 0) parts.push(`${agentProblems} agent posture problem(s)`);
    if (setProblems > 0) parts.push(`${setProblems} RedSkills package set problem(s)`);
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

        // Whose keys, asked here and nowhere the converge can reach. The
        // converge below installs the SSH server and opens the port on
        // every machine; until this question existed it authorized
        // nobody, so the port was open and the machine unreachable. The
        // file is written before sshd exists, which is the right order —
        // it reads it when it starts, and `red-dev ssh <github-user>` is
        // the way in for every run that is not a first one. See
        // src/ssh-access.ts.
        const { offerGithubKeys } = await import("./ssh-access.ts");
        await offerGithubKeys(p);
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

  // Direct `red-dev install` reaches here without the first-run interview.
  // Prime once before either fullscreen or line reporting begins. `--yes`
  // remains strictly unattended and non-TTY runs never ask anything.
  if (!inv.dryRun && !inv.yes && interactive() && !sudoPrepared) {
    await prepareSudo(p, scopes);
  }

  // Fullscreen when there is a terminal wide enough for it: the live
  // view is the default experience, and the line report is what runs in
  // CI, in a pipe, over a dumb SSH session and on a narrow window.
  if (!inv.dryRun && interactive() && (process.stdout.columns ?? 0) >= 60) {
    const { runInstallTui } = await import("./tui-install.ts");
    const outcome = await runInstallTui({ platform: p, ctx, scopes });
    // The banner again, after the frame is released. The completion
    // screen said this inside the interface, and the interface is gone
    // by the time anyone scrolls back — the terminal has to hold the
    // verdict too, or the evidence exists only for as long as the
    // fullscreen did.
    return await endInstall(outcome.results, outcome.elapsedMs);
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

  return await endInstall(summaryOf.results, Date.now() - startedAt, { dryRun: inv.dryRun });
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
  options: { dryRun?: boolean } = {},
): Promise<number> {
  const { completionBanner, convergeVerdict, shortenHome } = await import("./completion.ts");
  const { transcriptPath } = await import("./transcript.ts");
  const { convergeExit } = await import("./converge.ts");

  const verdict = convergeVerdict(items, elapsedMs, {
    logPath: shortenHome(transcriptPath(), process.env["HOME"] ?? process.env["USERPROFILE"]),
    ...(options.dryRun === true ? { dryRun: true } : {}),
  });
  for (const line of completionBanner(verdict, process.stdout.columns ?? 72)) log.plain(line);

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
  const { runUpdate } = await import("./update-order.ts");

  const stages: Record<UpdateStage, () => Promise<number | void>> = {
    system: () => systemUpdate(p),

    // Before the converge, because the converge builds out of this tree:
    // convergeRedSkills stops at "already wired", which is correct for
    // install and leaves the checkout frozen forever under update.
    "red-skills": async () => {
      if (inv.dryRun) return;
      const { updateRedSkills } = await import("./agents.ts");
      await updateRedSkills(p);
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
      await cmdAgentsUpdate(p);
    },

    // Upgrading can leave the manifest unsatisfied (a package removed, a
    // binary replaced), so always re-converge afterwards.
    converge: () => cmdInstall(p, inv, "update"),

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
  );
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
  const choices = ["theme", ...themeNames(), "custom"] as [string, ...string[]];
  let chosen =
    name ??
    (await select(
      "Wallpaper? ('theme' follows the colour theme; 'custom' imports a PNG)",
      choices,
      prefs.wallpaper && themeFor(prefs.wallpaper)
        ? prefs.wallpaper
        : prefs.wallpaper?.startsWith("custom:")
          ? "custom"
          : "theme",
    ));
  if (chosen === "custom") {
    if (!interactive()) {
      log.err("custom wallpaper needs an absolute PNG path or HTTPS URL");
      return 1;
    }
    chosen = await text("Absolute PNG path or HTTPS URL?");
  }

  const colourSlug = (await contextFor(p, inv, "theme")).theme;
  let preference: string | undefined;
  let label: string;
  if (chosen === "theme") {
    preference = undefined;
    label = `${colourSlug} (follows theme)`;
  } else if (themeFor(chosen)) {
    preference = chosen;
    label = chosen;
  } else {
    try {
      const { importCustomWallpaper } = await import("./wallpaper.ts");
      const imported = await importCustomWallpaper(chosen, p);
      preference = imported.preference;
      label = `custom PNG (${Math.ceil(imported.bytes / 1024)} KiB imported)`;
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
  const labels = lines.map((line) => line.label);
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
  const { askGithubUser, authorizeGithubKeys, reportAuthorization } = await import(
    "./ssh-access.ts"
  );

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
  const picked = await checkbox("Which agents?", labels as [string, ...string[]], labels);
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
 * `red-dev agents default [key]` — report the recorded host, or record
 * a different one.
 *
 * Naming a host that is not installed is allowed and warned about
 * rather than refused: someone setting a machine up in the order they
 * choose is not making a mistake, and `doctor` says the same thing
 * afterwards until the host arrives.
 */
async function cmdAgentsDefault(p: Platform, key: string | undefined): Promise<number> {
  const { AGENTS, availableAgents, currentAgentKeys, isAgentInstalled } = await import(
    "./agents.ts"
  );
  const { isDefaultAgentCandidate, readDefaultAgent, reportDefaultAgent } = await import(
    "./default-agent.ts"
  );
  const { readPreferences, writePreferences } = await import("./preferences.ts");
  const offered = availableAgents(p).filter(isDefaultAgentCandidate);

  if (key === undefined) {
    const prefs = await readPreferences(p);
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
  if (!isAgentInstalled(spec)) log.warn(`not installed yet — red-dev agents ${spec.key}`);
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
  const decision = resolveLaunch(prefs, commandPath, passthrough);
  if (!decision.ok) {
    log.err(decision.detail);
    if (decision.fix) log.plain(`       fix: ${decision.fix}`);
    return 1;
  }

  try {
    return await runLaunchTarget(decision.target);
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
async function cmdAgentsUpdate(p: Platform): Promise<number> {
  const { availableAgents } = await import("./agents.ts");
  const { reportAgentUpdate, updateAgents } = await import("./agent-update.ts");

  const hosts = availableAgents(p);
  log.step(`agents: updating ${hosts.length} known hosts, each by its publisher`);
  const outcomes = await updateAgents(hosts, p, { report: reportAgentUpdate });

  const failed = outcomes.filter((outcome) => outcome.state === "failed");
  const updated = outcomes.filter((outcome) => outcome.state === "updated").length;
  // Counted rather than narrated: a machine where nothing moved is the
  // ordinary result of running this twice, and it should read like one.
  if (failed.length === 0) {
    log.ok(updated === 0 ? "every agent host was already current" : `${updated} agent host(s) updated`);
    return 0;
  }
  log.err(`${failed.length} agent host(s) failed: ${failed.map((f) => f.key).join(", ")}`);
  return 1;
}

/** Choose which language runtimes mise manages. */
async function cmdLang(p: Platform, inv: Invocation): Promise<number> {
  const { checkbox, select } = await import("./ui.ts");
  const {
    OFFERED_RUNTIMES,
    offeredRuntime,
    useRuntimes,
    currentRuntimes,
    resolveRuntimeIds,
    runtimeSelectedByDefault,
  } =
    await import("./runtimes.ts");

  let ids = inv.runtimeIds;
  if (ids !== undefined) {
    // `--latest` makes the channel explicit, so the terse and natural
    // `red-dev lang --latest node,python` is enough. Selectors supplied
    // alongside it are intentionally replaced by the same policy.
    const resolved = resolveRuntimeIds(ids, inv.latest ? "latest" : "recommended");
    ids = resolved.ids;
    const { unknown } = resolved;
    if (unknown.length > 0) {
      log.err(`unknown runtime(s): ${unknown.join(", ")}`);
      log.plain(
        `     known runtime names: ${OFFERED_RUNTIMES.map((runtime) => runtime.id.split("@")[0]).join(", ")}`,
      );
      log.plain("     use @latest, the recommended selector shown by `red-dev lang`, or an exact version");
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

    const versioned: string[] = [];
    for (const id of ids) {
      const runtime = offeredRuntime(id);
      if (!runtime) {
        versioned.push(id);
        continue;
      }
      const versions = runtime.versions.map((version) => `${version.id} — ${version.label}`);
      const fallback = versions.find((version) => version.startsWith(`${id} `)) ?? versions[0]!;
      const picked = await select(
        `${runtime.label} version?`,
        versions as [string, ...string[]],
        fallback,
      );
      versioned.push(picked.split(" ")[0]!);
    }
    ids = versioned;
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
