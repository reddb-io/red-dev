import type { Invocation } from "./cli.ts";
import { VERSION } from "./cli.ts";
import { captureTo, log } from "./log.ts";
import { applicableScopes, describeProvider, installedVersion, installState, isInstalled, providerFor, toolsInScope, type Scope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { doctorRepair, type DoctorRepair } from "./doctor-repair.ts";
import { encodeDoctorReport, writeDoctorReport } from "./doctor-report.ts";

function resolveScopes(p: Platform, arg?: string): Scope[] { return arg ? [arg as Scope] : applicableScopes(p); }

async function inspectDoctor(p: Platform, inv: Invocation): Promise<number> {
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
    for (const incident of snapshot.metrics.oomIncidents ?? []) {
      const victim = incident.pid === null ? "victim PID unavailable" : `PID ${incident.pid} (${incident.command ?? "unknown command"})`;
      log.warn(`OOM ${incident.at}: ${victim}; ${incident.cgroup ?? incident.unit ?? "group unavailable"}; source ${incident.source}`);
    }
    if (snapshot.metrics.oomEvents.length > 0 && snapshot.metrics.kernelOomEvidenceKnown === false) {
      log.skip("kernel OOM victim evidence unavailable to this user; current PIDs are not used to guess historical victims");
    }
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

    // The agents, which the walk above does not reach: it examines
    // tools mise provides, and a host installed from a GitHub release
    // into ~/.local/bin is not one. That gap let an npm copy from
    // before RedCode moved publishers answer to `redcode` for three
    // releases while every install said `ok`. See src/shadow-repair.ts.
    const { checkShadow } = await import("./shadow-repair.ts");
    const { AGENTS, agentInstallMethod, commandPath } = await import("./agents.ts");
    const { userBinDir, windowsBinDir } = await import("./providers.ts");
    for (const a of AGENTS) {
      if (a.cmd.length === 0 || agentInstallMethod(a, p) !== "github-release") continue;
      const running = commandPath(a.cmd);
      if (running === null) continue;
      const bin = p.os === "windows" ? windowsBinDir() : userBinDir();
      const check = checkShadow(running, `${bin}/${a.cmd}${p.os === "windows" ? ".exe" : ""}`);
      if (!check.shadowed) continue;
      log.warn(`${a.cmd} — ${check.running} answers first; red-dev installs ${check.installed}`);
      log.plain("       fix: red-dev agents update — it removes the copy it can identify");
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

  // And the same question of the companions: which set each of the
  // runtimes, the daemon, the herdr plugin, the extension and zellij came
  // out of, and which version of the artifact itself that produced. The
  // second half is the one the hosts do not have to answer — a `.vsix`
  // carries its own version, and "which extension is on this machine" is
  // not something the set's version can say.
  const { redSkillsCompanionReport, redSkillsCompanionRows } = await import(
    "./red-skills-companions.ts"
  );
  for (const row of redSkillsCompanionRows(redSkillsCompanionReport(setHome))) {
    if (row.status === "ok") log.ok(row.detail);
    else if (row.status === "n/a") log.skip(row.detail);
    else log.warn(row.detail);
  }

  // And how the last update across all of them ended. The three reports
  // above each answer for one surface; this answers for the operation,
  // which is the only place two facts can be said at all: which surfaces
  // were held back because a Worker was using the active revision, and
  // whether a run that failed left this machine between two revisions
  // rather than on neither.
  const { stagedUpdateReport, stagedUpdateRows } = await import("./staged-update.ts");
  for (const row of stagedUpdateRows(stagedUpdateReport(setHome))) {
    if (row.status === "ok") log.ok(row.detail);
    else if (row.status === "n/a") log.skip(row.detail);
    else if (row.status === "warn") log.warn(row.detail);
    else {
      log.err(row.detail);
      setProblems++;
    }
  }

  // And, on a machine that was provisioned from a USB stick rather than
  // from the network, which depot it came off: the digest, the target it
  // was cut for, who signed it, whether its machine-owned copy is still
  // addressable, and the accounts nobody could have configured without
  // egress. That last group is reported and never counted — an air-gapped
  // workstation with seven CLIs installed and seven logins outstanding has
  // succeeded, and doctor that said otherwise would be ignored.
  const { offlineDepotReport, offlineDepotRows } = await import("./offline-depot.ts");
  for (const row of offlineDepotRows(offlineDepotReport(setHome))) {
    if (row.status === "ok") log.ok(row.detail);
    else if (row.status === "n/a") log.skip(row.detail);
    else if (row.status === "warn") log.warn(row.detail);
    else {
      log.err(row.detail);
      setProblems++;
    }
  }

  // And what this machine could go back to, which is the one question the
  // reports above cannot answer between them: which complete revision is
  // active — the package set and the exact lock, named as one thing —
  // what a rollback would restore, whether all of it is still on disk,
  // and how much derived state the retention is holding to keep that
  // true. An unrestorable rollback target is an error rather than a
  // warning: the machine still works, and the promise that it can be put
  // back does not.
  const { workstationRollbackReport, workstationRollbackRows } = await import(
    "./workstation-rollback.ts"
  );
  for (const row of workstationRollbackRows(workstationRollbackReport(setHome))) {
    if (row.status === "ok") log.ok(row.detail);
    else if (row.status === "n/a") log.skip(row.detail);
    else if (row.status === "warn") log.warn(row.detail);
    else {
      log.err(row.detail);
      setProblems++;
    }
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

export async function doctorCommand(p: Platform, inv: Invocation): Promise<number> {
  if (!inv.json && !inv.doctorExport) return inv.doctorRepair
    ? doctorRepair(p, inv.doctorRepair as DoctorRepair, inv.apply)
    : inspectDoctor(p, inv);
  const lines: string[] = [];
  const restore = captureTo(line => lines.push(line));
  let code: number;
  try {
    code = inv.doctorRepair
      ? await doctorRepair(p, inv.doctorRepair as DoctorRepair, inv.apply)
      : await inspectDoctor(p, inv);
  } finally { restore(); }
  const report = { schema: "red.doctor-report.v1", version: VERSION, platform: p, exitCode: code, lines };
  const encoded = encodeDoctorReport(report);
  if (inv.doctorExport) writeDoctorReport(inv.doctorExport, encoded);
  if (inv.json) log.plain(encoded);
  else {
    for (const line of lines) log.plain(line);
    if (inv.doctorExport) log.ok(`private diagnostic report written to ${inv.doctorExport}`);
  }
  return code;
}
