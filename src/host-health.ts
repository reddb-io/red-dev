export type HealthLevel = "ok" | "warning" | "critical";
export type ProcessDisposition = "protected" | "proven-orphan" | "suspect";

export interface ProcessRecord {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  uid: number | null;
  /** Linux /proc start-time ticks, used to detect PID reuse. */
  startTime: string;
  state: string;
  ageSeconds: number;
  tasks: number;
  comm: string;
  argv: string[];
  cwd: string | null;
  cwdDeleted: boolean;
  tty: string | null;
  unit: string | null;
  cgroup: string | null;
  reparented: boolean;
  /** PIDs outside this process group which still own one of its stdio endpoints. */
  externalStdioPeers: number[];
  /** False when permissions/races prevented complete process-FD observation. */
  stdioObservationKnown: boolean;
  /** False for socket-pair stdio whose peer cannot be derived from fd inode text. */
  stdioPeerLinkKnown: boolean;
}

export interface WorkerIdentity {
  pid: number;
  unit: string | null;
}

export interface HostMetrics {
  processCount: number;
  taskCount: number;
  pidsCurrent: number | null;
  pidsMax: number | null;
  memoryAvailableBytes: number | null;
  memoryTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  oomEvents: string[];
  stopTimeouts: number;
  workerLimitsKnown: boolean;
  workerTasksMax: Array<number | "infinity">;
  workerMemoryCurrent: number[];
  workerMemoryMax: Array<number | "infinity">;
}

export interface HostSnapshot {
  capturedAt: string;
  currentPid: number;
  currentUid: number;
  processes: ProcessRecord[];
  workers: WorkerIdentity[];
  /** False means the daemon was absent or spoke an unknown protocol. */
  workerStateKnown: boolean;
  activeUnits: string[];
  /** False means systemd unit protection could not be observed safely. */
  activeUnitsKnown: boolean;
  /** False when any process could not have all file descriptors observed completely. */
  stdioUniverseKnown: boolean;
  /** False when procfs hidepid can conceal whole processes from the census. */
  processUniverseKnown: boolean;
  redskilledPid: number | null;
  metrics: HostMetrics;
}

export interface ProcessGroupAssessment {
  pgid: number;
  pids: number[];
  disposition: ProcessDisposition;
  reasons: string[];
}

export interface HealthFinding {
  id: string;
  level: Exclude<HealthLevel, "ok">;
  detail: string;
}

export interface HostAssessment {
  level: HealthLevel;
  findings: HealthFinding[];
  groups: ProcessGroupAssessment[];
}

const MIN_ORPHAN_AGE_SECONDS = 120;

function isKnownStatusline(process: ProcessRecord): boolean {
  return (
    process.argv.some((arg) => /red-skills\/(?:bundles|dev)|red-skills\/bundles|dev-[^/]*\.bundle/i.test(arg)) &&
    process.argv.includes("statusline")
  );
}

function isKnownTestHelper(process: ProcessRecord): boolean {
  return process.argv.some(
    (arg) =>
      /\/tests\/support\/(?:go-dispatch-dispatcher|.*(?:dispatcher|worker))\.(?:ts|js)$/i.test(arg) ||
      /\/(?:tsx|esbuild)(?:\/|$)/i.test(arg),
  );
}

function groupByPgid(processes: ProcessRecord[]): Map<number, ProcessRecord[]> {
  const groups = new Map<number, ProcessRecord[]>();
  for (const process of processes) {
    const group = groups.get(process.pgid) ?? [];
    group.push(process);
    groups.set(process.pgid, group);
  }
  return groups;
}

function descendsFrom(pid: number, ancestor: number, byPid: Map<number, ProcessRecord>): boolean {
  const seen = new Set<number>();
  let cursor = byPid.get(pid);
  while (cursor && !seen.has(cursor.pid)) {
    if (cursor.ppid === ancestor) return true;
    seen.add(cursor.pid);
    cursor = byPid.get(cursor.ppid);
  }
  return false;
}

export function assessHost(snapshot: HostSnapshot): HostAssessment {
  const groups: ProcessGroupAssessment[] = [];
  const findings: HealthFinding[] = [];
  const byPid = new Map(snapshot.processes.map((process) => [process.pid, process]));
  const currentAncestry = new Set<number>();
  let current = byPid.get(snapshot.currentPid);
  while (current && !currentAncestry.has(current.pid)) {
    currentAncestry.add(current.pid);
    current = byPid.get(current.ppid);
  }

  if (snapshot.metrics.processCount >= 5_000) {
    findings.push({
      id: "process-count",
      level: "critical",
      detail: `${snapshot.metrics.processCount.toLocaleString("en-US")} processes`,
    });
  } else if (snapshot.metrics.processCount >= 1_000) {
    findings.push({
      id: "process-count",
      level: "warning",
      detail: `${snapshot.metrics.processCount.toLocaleString("en-US")} processes`,
    });
  }

  if (snapshot.metrics.taskCount >= 15_000) {
    findings.push({ id: "task-count", level: "critical", detail: `${snapshot.metrics.taskCount.toLocaleString("en-US")} tasks` });
  } else if (snapshot.metrics.taskCount >= 4_000) {
    findings.push({ id: "task-count", level: "warning", detail: `${snapshot.metrics.taskCount.toLocaleString("en-US")} tasks` });
  }

  if (
    snapshot.metrics.pidsCurrent !== null &&
    snapshot.metrics.pidsMax !== null &&
    snapshot.metrics.pidsMax > 0
  ) {
    const ratio = snapshot.metrics.pidsCurrent / snapshot.metrics.pidsMax;
    if (ratio >= 0.8) {
      findings.push({ id: "pid-capacity", level: "critical", detail: `${Math.round(ratio * 100)}% of pids.max` });
    } else if (ratio >= 0.5) {
      findings.push({ id: "pid-capacity", level: "warning", detail: `${Math.round(ratio * 100)}% of pids.max` });
    }
  }

  if (
    snapshot.metrics.memoryAvailableBytes !== null &&
    snapshot.metrics.memoryTotalBytes !== null &&
    snapshot.metrics.memoryTotalBytes > 0
  ) {
    const ratio = snapshot.metrics.memoryAvailableBytes / snapshot.metrics.memoryTotalBytes;
    if (ratio < 0.05) {
      findings.push({ id: "memory", level: "critical", detail: `${Math.round(ratio * 100)}% available` });
    } else if (ratio < 0.15) {
      findings.push({ id: "memory", level: "warning", detail: `${Math.round(ratio * 100)}% available` });
    }
  }

  if (
    snapshot.metrics.diskFreeBytes !== null &&
    snapshot.metrics.diskTotalBytes !== null &&
    snapshot.metrics.diskTotalBytes > 0
  ) {
    const ratio = snapshot.metrics.diskFreeBytes / snapshot.metrics.diskTotalBytes;
    const gib = snapshot.metrics.diskFreeBytes / 1024 ** 3;
    if (ratio < 0.05 || gib < 10) {
      findings.push({ id: "disk", level: "critical", detail: `${gib.toFixed(1)} GiB free` });
    } else if (ratio < 0.15 || gib < 20) {
      findings.push({ id: "disk", level: "warning", detail: `${gib.toFixed(1)} GiB free` });
    }
  }

  const capturedAt = Date.parse(snapshot.capturedAt);
  const recentOoms = snapshot.metrics.oomEvents
    .map(Date.parse)
    .filter((at) => Number.isFinite(at) && capturedAt - at >= 0 && capturedAt - at <= 24 * 60 * 60 * 1_000);
  if (recentOoms.length > 0) {
    const inLastHour = recentOoms.some((at) => capturedAt - at <= 60 * 60 * 1_000);
    findings.push({
      id: "oom",
      level: inLastHour || recentOoms.length >= 3 ? "critical" : "warning",
      detail: `${recentOoms.length} OOM event(s) in 24h`,
    });
  }

  if (snapshot.metrics.stopTimeouts > 0) {
    findings.push({
      id: "stop-timeout",
      level: "warning",
      detail: `${snapshot.metrics.stopTimeouts} stop timeout(s) in 24h`,
    });
  }

  if (!snapshot.metrics.workerLimitsKnown) {
    findings.push({
      id: "worker-limits",
      level: "warning",
      detail: "Worker TasksMax/MemoryCurrent/MemoryMax observation is unknown",
    });
  }

  if (snapshot.metrics.workerTasksMax.includes("infinity")) {
    findings.push({ id: "worker-tasks-max", level: "critical", detail: "a Worker has TasksMax=infinity" });
  } else if (
    snapshot.metrics.workerTasksMax.some((limit) => typeof limit === "number" && limit > 2_048)
  ) {
    findings.push({ id: "worker-tasks-max", level: "warning", detail: "a Worker TasksMax exceeds 2,048" });
  }

  const currentUserProcesses = snapshot.processes.filter(
    (process) => process.uid === snapshot.currentUid,
  );
  const zombies = currentUserProcesses.filter((process) => process.state === "Z").length;
  if (zombies > 0) {
    findings.push({
      id: "zombies",
      level: zombies >= 100 ? "critical" : "warning",
      detail: `${zombies} zombie process(es)`,
    });
  }
  const deletedCwds = currentUserProcesses.filter((process) => process.cwdDeleted).length;
  if (deletedCwds > 0) {
    findings.push({
      id: "deleted-cwd",
      level: "warning",
      detail: `${deletedCwds} process(es) with a deleted working directory`,
    });
  }
  if (snapshot.metrics.workerMemoryMax.includes("infinity")) {
    findings.push({
      id: "worker-memory-max",
      level: "critical",
      detail: "a Worker has MemoryMax=infinity",
    });
  }

  for (const [pgid, members] of groupByPgid(snapshot.processes)) {
    const statusline = members.some(isKnownStatusline);
    const testHelper = members.some(isKnownTestHelper);
    const workerShaped = members.some((process) => /^red-worker-.*\.service$/.test(process.unit ?? ""));
    if (!statusline && !testHelper && !workerShaped) continue;

    if (members.some((process) => currentAncestry.has(process.pid))) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["current command ancestry"],
      });
      continue;
    }

    if (workerShaped && !snapshot.workerStateKnown) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["Worker state unknown"],
      });
      continue;
    }

    if (!snapshot.activeUnitsKnown) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["systemd unit state unknown"],
      });
      continue;
    }

    if (members.some((process) => process.tty !== null)) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["active terminal"],
      });
      continue;
    }

    if (
      snapshot.redskilledPid !== null &&
      members.some((process) => descendsFrom(process.pid, snapshot.redskilledPid as number, byPid))
    ) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["redskilled descendant"],
      });
      continue;
    }

    const workerUnits = new Set(snapshot.workers.map((worker) => worker.unit).filter(Boolean));
    const registeredWorker = members.some(
      (process) =>
        (process.unit !== null && workerUnits.has(process.unit)) ||
        snapshot.workers.some((worker) => worker.pid === process.pid),
    );
    if (registeredWorker) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["registered Worker"],
      });
      continue;
    }
    if (
      members.some(
        (process) => process.unit !== null && snapshot.activeUnits.includes(process.unit),
      )
    ) {
      groups.push({
        pgid,
        pids: members.map((process) => process.pid).sort((a, b) => a - b),
        disposition: "protected",
        reasons: ["active systemd unit"],
      });
      continue;
    }

    const reasons: string[] = [
      statusline ? "known statusline" : testHelper ? "known test helper" : "inactive Worker unit",
    ];
    if (members.some((process) => process.cwdDeleted)) reasons.push("deleted cwd");
    if (members.some((process) => process.reparented)) reasons.push("reparented");
    if (members.every((process) => process.tty === null)) reasons.push("no terminal");
    if (
      statusline &&
      snapshot.stdioUniverseKnown &&
      members.every(
        (process) =>
          process.stdioObservationKnown &&
          process.stdioPeerLinkKnown &&
          process.externalStdioPeers.length === 0,
      )
    ) {
      reasons.push("no external stdio owner");
    }

    const proven =
      snapshot.processUniverseKnown &&
      members.every((process) => process.uid === snapshot.currentUid) &&
      members.every((process) => process.ageSeconds >= MIN_ORPHAN_AGE_SECONDS) &&
      reasons.includes("reparented") &&
      reasons.includes("no terminal") &&
      (statusline ? reasons.includes("no external stdio owner") : reasons.includes("deleted cwd"));

    groups.push({
      pgid,
      pids: members.map((process) => process.pid).sort((a, b) => a - b),
      disposition: proven ? "proven-orphan" : "suspect",
      reasons,
    });
  }

  const orphans = groups.filter((group) => group.disposition === "proven-orphan");
  const orphanProcesses = orphans.reduce((sum, group) => sum + group.pids.length, 0);
  if (orphans.length > 0) {
    findings.push({
      id: "orphan-groups",
      level: orphanProcesses >= 100 ? "critical" : "warning",
      detail: `${orphans.length} proven orphan group(s), ${orphanProcesses} process(es)`,
    });
  }

  const level: HealthLevel = findings.some((finding) => finding.level === "critical")
    ? "critical"
    : findings.length > 0
      ? "warning"
      : "ok";
  return { level, findings, groups };
}
