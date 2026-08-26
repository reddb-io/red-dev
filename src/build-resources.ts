import { totalmem } from "node:os";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { localPath } from "./shared-root.ts";
import { powershellBin, windowsUserProfile } from "./wsl.ts";
import {
  hostDiskThresholds,
  workloadLogicalCpuCount,
  workloadPolicy,
} from "./workload-policy.ts";

const file = Bun.file;
const spawn = Bun.spawn;
const write = Bun.write;
const readStreamText = async (stream: ReadableStream<Uint8Array> | null): Promise<string> =>
  stream === null ? "" : await new Response(stream).text();

export { hostDiskThresholds } from "./workload-policy.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const CARGO_INCLUDE = "../.config/red-dev/cargo.toml";
const CARGO_INCLUDE_MARKER = "# red-dev:build-resources begin";
const CARGO_INCLUDE_LINE = `include = ["${CARGO_INCLUDE}"]`;

export interface BuildResourcePolicy {
  /** Maximum concurrent rustc processes. */
  cargoJobs: number;
  /** Standard libtest concurrency. */
  rustTestThreads: number;
  /** Recommended nextest process pool; repositories may override it. */
  nextestThreads: number;
}

/**
 * A memory-first default for compilation and test execution. PURE.
 *
 * Rust compilation commonly has several large rustc/linker processes alive at
 * once, so logical CPUs are an unsafe default on a development workstation.
 * One compile slot per 4 GiB and one libtest thread per 8 GiB leave room for
 * the editor and coding agent. The ceilings keep a large host useful without
 * turning one build into the machine's only tenant.
 */
export function buildResourcePolicy(input: {
  totalMemoryBytes: number;
  logicalCpus: number;
}): BuildResourcePolicy {
  // Hypervisors reserve a small amount, so a configured 16 GiB guest reports
  // roughly 15.5 GiB. Round to the nominal capacity before deriving slots.
  const memoryGiB = Math.max(1, Math.round(input.totalMemoryBytes / GIB));
  const cpus = Math.max(1, Math.floor(input.logicalCpus));
  const cpuHalf = Math.max(1, Math.floor(cpus / 2));
  const cargoJobs = Math.max(1, Math.min(8, cpuHalf, Math.max(1, Math.floor(memoryGiB / 4))));
  const rustTestThreads = Math.max(
    1,
    Math.min(4, cargoJobs, Math.max(1, Math.floor(memoryGiB / 8))),
  );
  return { cargoJobs, rustTestThreads, nextestThreads: cargoJobs };
}

/** The low-priority Cargo layer; repository config and the user's env win. */
export function renderCargoDefaults(policy: BuildResourcePolicy): string {
  return `# Managed by red-dev. Loaded from ~/.cargo/config.toml at Cargo's
# lowest (home) precedence; a repository's .cargo/config.toml wins.
# Do not put target-dir, incremental or rustflags here: those are project policy.

[build]
jobs = ${policy.cargoJobs}

[env]
# libtest still recognises this compatibility variable. An explicitly exported
# value wins because force=false; projects may also override it in deeper config.
RUST_TEST_THREADS = { value = "${policy.rustTestThreads}", force = false }
`;
}

export type CargoHomeConfigPlan =
  | { action: "write"; content: string }
  | { action: "current"; content: string }
  | { action: "blocked"; content: string; reason: string };

/**
 * Put red-dev below the person's Cargo config without parsing or rewriting it.
 *
 * Cargo merges includes first and the including file second, so values already
 * in ~/.cargo/config.toml keep the last word. A pre-existing include graph is
 * left alone because inserting into arbitrary TOML arrays without a parser is
 * not an ownership-safe edit.
 */
export function cargoHomeConfigPlan(existing: string | null): CargoHomeConfigPlan {
  if (existing?.includes(CARGO_INCLUDE_MARKER)) {
    // Cargo releases before table-form includes accept strings only. Migrate
    // the short-lived red-dev table form in place; this is our marked block.
    const migrated = existing.replace(
      /^include\s*=\s*\[\{\s*path\s*=\s*"\.\.\/\.config\/red-dev\/cargo\.toml"[^\n]*$/m,
      CARGO_INCLUDE_LINE,
    );
    return migrated === existing
      ? { action: "current", content: existing }
      : { action: "write", content: migrated };
  }
  if (existing?.includes(CARGO_INCLUDE)) {
    return { action: "current", content: existing };
  }
  if (existing !== null && /^\s*include\s*=/m.test(existing)) {
    return {
      action: "blocked",
      content: existing,
      reason: `Cargo config already declares include; add ${CARGO_INCLUDE} to that list`,
    };
  }

  const block = `${CARGO_INCLUDE_MARKER}
# Your settings in this file are merged afterwards and therefore win.
${CARGO_INCLUDE_LINE}
# red-dev:build-resources end

`;
  if (existing === null) return { action: "write", content: block };
  if (existing.startsWith("\uFEFF")) {
    return { action: "write", content: `\uFEFF${block}${existing.slice(1)}` };
  }
  return { action: "write", content: block + existing };
}

export type WslHostConfigPlan =
  | { action: "write"; content: string; added: string[] }
  | { action: "current"; content: string; added: string[] }
  | { action: "blocked"; content: string; added: string[]; reason: string };

export function recommendedWslProcessors(logicalCpus: number): number {
  const cpus = Math.max(1, Math.floor(logicalCpus));
  return cpus <= 2 ? cpus : cpus - 2;
}

export function parseWindowsPhysicalMemory(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const bytes = Number(trimmed);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : null;
}

export function parseWindowsLogicalCpus(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const count = Number(trimmed);
  return Number.isSafeInteger(count) && count > 0 ? count : null;
}

/** WSL receives 60% of physical RAM, rounded down to an integral MiB. */
export function recommendedWslMemoryMiB(physicalMemoryBytes: number): number {
  return Math.max(1024, Math.floor((physicalMemoryBytes * 60) / 100 / MIB));
}

async function windowsPhysicalMemoryBytes(): Promise<number | null> {
  const proc = spawn([
    powershellBin(),
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[int64](Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
  ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = await readStreamText(proc.stdout);
  return (await proc.exited) === 0 ? parseWindowsPhysicalMemory(output) : null;
}

async function windowsLogicalCpuCount(): Promise<number | null> {
  const proc = spawn([
    powershellBin(),
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[int](Get-CimInstance Win32_ComputerSystem).NumberOfLogicalProcessors",
  ], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const output = await readStreamText(proc.stdout);
  return (await proc.exited) === 0 ? parseWindowsLogicalCpus(output) : null;
}

async function commandOutput(argv: readonly string[]): Promise<{ code: number; output: string } | null> {
  try {
    const proc = spawn([...argv], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const output = await readStreamText(proc.stdout);
    return { code: await proc.exited, output: output.trim() };
  } catch {
    return null;
  }
}

export function parseHostDiskDf(output: string): { totalKiB: number; freeKiB: number } | null {
  const line = output.trim().split(/\r?\n/).at(-1)?.trim() ?? "";
  const fields = line.split(/\s+/);
  const totalKiB = Number(fields[1]);
  const freeKiB = Number(fields[3]);
  if (
    fields.length < 6 || !Number.isSafeInteger(totalKiB) || totalKiB <= 0 ||
    !Number.isSafeInteger(freeKiB) || freeKiB < 0
  ) return null;
  return { totalKiB, freeKiB };
}

/** Preserve unrelated WSL settings while enforcing the workstation memory cap. PURE. */
export function wslHostConfigPlan(
  existing: string | null,
  logicalCpus: number,
  physicalMemoryBytes?: number,
): WslHostConfigPlan {
  let content = existing ?? "";
  content = content
    .split("# Added by red-dev; existing operator values are never replaced.")
    .join("# Added by red-dev; unrelated operator values are preserved.");
  const added: string[] = [];
  const duplicate = (name: string): boolean => {
    const matches = content.match(new RegExp(`^\\s*\\[${name}\\]\\s*$`, "gim"));
    return (matches?.length ?? 0) > 1;
  };
  if (duplicate("wsl2") || duplicate("experimental")) {
    return {
      action: "blocked",
      content,
      added: [],
      reason: ".wslconfig declares a section more than once; red-dev left it untouched",
    };
  }

  const ensure = (section: string, entries: Readonly<Record<string, string>>): void => {
    const lines = content.replace(/\r\n/g, "\n").split("\n");
    const start = lines.findIndex((line) =>
      line.trim().toLowerCase() === `[${section.toLowerCase()}]`
    );
    if (start < 0) {
      const suffix = content.trimEnd();
      const body = Object.entries(entries).map(([key, value]) => `${key}=${value}`);
      content = `${suffix}${suffix ? "\n\n" : ""}[${section}]\n${body.join("\n")}\n`;
      added.push(...Object.keys(entries).map((key) => `${section}.${key}`));
      return;
    }
    let end = lines.findIndex((line, index) => index > start && /^\s*\[.+\]\s*$/.test(line));
    if (end < 0) end = lines.length;
    const present = new Set(
      lines.slice(start + 1, end).flatMap((line) => {
        const match = /^\s*([A-Za-z][A-Za-z0-9]*)\s*=/.exec(line);
        return match?.[1] ? [match[1].toLowerCase()] : [];
      }),
    );
    const missing = Object.entries(entries).filter(([key]) => !present.has(key.toLowerCase()));
    if (missing.length === 0) return;
    const inserted = [
      "# Added by red-dev; unrelated operator values are preserved.",
      ...missing.map(([key, value]) => `${key}=${value}`),
    ];
    content = `${[...lines.slice(0, end), ...inserted, ...lines.slice(end)].join("\n").trimEnd()}\n`;
    added.push(...missing.map(([key]) => `${section}.${key}`));
  };

  const memory = physicalMemoryBytes === undefined
    ? undefined
    : `${recommendedWslMemoryMiB(physicalMemoryBytes)}MB`;
  if (memory !== undefined && /^\s*memory\s*=/im.test(content)) {
    const current = /^\s*memory\s*=\s*([^\r\n#;]+)/im.exec(content)?.[1]?.trim();
    if (current !== memory) {
      content = content.replace(/^(\s*memory\s*=\s*)[^\r\n#;]+/im, `$1${memory}`);
      added.push("wsl2.memory");
    }
  }

  const wsl2: Record<string, string> = {};
  if (memory !== undefined) wsl2["memory"] = memory;
  wsl2["processors"] = String(recommendedWslProcessors(logicalCpus));
  wsl2["swap"] = "4GB";
  wsl2["maxCrashDumpCount"] = "1";
  ensure("wsl2", wsl2);
  ensure("experimental", { autoMemoryReclaim: "dropCache" });
  return added.length === 0
    ? { action: "current", content, added: [] }
    : { action: "write", content, added };
}

function userHome(): string {
  const value = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!value) throw new Error("neither HOME nor USERPROFILE is set");
  return value.replace(/\\/g, "/");
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if (existsSync(path) && (await file(path).text()) === content) return false;
  await write(path, content);
  return true;
}

export interface BuildResourceFinding {
  name: string;
  status: "ok" | "drift" | "n/a";
  detail: string;
  fix?: string;
}

export interface HostDiskGuardObservation {
  totalKiB: number | null;
  freeKiB: number | null;
  timerEnabled: boolean | null;
  timerActive: boolean | null;
  serviceResult: string | null;
  serviceExitStatus: number | null;
  buildFreezerState: string | null;
  agentFreezerState: string | null;
  frozenMarker: string | null;
  lastEvent: string | null;
}

export interface BuildResourceObservation {
  cargoDefaults: string | null;
  cargoHome: string | null;
  workloadShell: string | null;
  diskGuardian?: string | null;
  systemd: readonly { path: string; content: string | null }[];
  totalMemoryBytes: number;
  logicalCpus: number;
  windowsLogicalCpus?: number | null;
  wslConfig?: string | null;
  windowsPhysicalMemoryBytes?: number | null;
  hostDiskGuard?: HostDiskGuardObservation;
}

function guardianEventSummary(value: string | null): string {
  if (value === null || value.trim() === "") return "none";
  return value.trim().split(/\s+/)
    .filter((part) => !part.startsWith("at=") && !part.startsWith("free_kib="))
    .join(" ");
}

function assessHostDiskGuard(observed: HostDiskGuardObservation | undefined): BuildResourceFinding {
  if (observed === undefined) {
    return {
      name: "host disk guard",
      status: "drift",
      detail: "disk guardian state is unavailable",
      fix: "red-dev install core",
    };
  }
  if (observed.timerEnabled !== true || observed.timerActive !== true) {
    return {
      name: "host disk guard",
      status: "drift",
      detail: "disk guardian timer is disabled/inactive",
      fix: "red-dev install core",
    };
  }
  if (observed.serviceResult !== "success" || observed.serviceExitStatus !== 0) {
    return {
      name: "host disk guard",
      status: "drift",
      detail: `last guardian run failed (${observed.serviceResult ?? "unknown"}/` +
        `${observed.serviceExitStatus ?? "unknown"})`,
      fix: "systemctl --user status red-dev-disk-guardian.service",
    };
  }
  if (observed.totalKiB === null || observed.freeKiB === null) {
    return {
      name: "host disk guard",
      status: "drift",
      detail: "Windows host disk capacity cannot be measured",
      fix: "df -Pk /mnt/c",
    };
  }

  const thresholds = hostDiskThresholds(observed.totalKiB);
  const buildsFrozen = observed.buildFreezerState === "frozen";
  const agentsFrozen = observed.agentFreezerState === "frozen";
  const bothFrozen = buildsFrozen && agentsFrozen;
  const bothRunning = observed.buildFreezerState === "running" &&
    observed.agentFreezerState === "running";
  const markedFrozen = observed.frozenMarker !== null;
  const shouldBeFrozen = observed.freeKiB < thresholds.floorKiB ||
    (observed.freeKiB < thresholds.resumeKiB && markedFrozen);
  if (
    (shouldBeFrozen && (!markedFrozen || !bothFrozen)) ||
    (!shouldBeFrozen && (markedFrozen || !bothRunning))
  ) {
    return {
      name: "host disk guard",
      status: "drift",
      detail: "guardian marker, disk threshold and cgroup freezer state disagree",
      fix: "systemctl --user start red-dev-disk-guardian.service",
    };
  }

  const gib = (kib: number): number => Math.floor(kib / 1024 ** 2);
  const admission = observed.freeKiB < thresholds.reserveKiB
    ? "admission blocked"
    : "admission open";
  return {
    name: "host disk guard",
    status: "ok",
    detail: `${gib(observed.freeKiB)} GiB free; ${gib(thresholds.reserveKiB)} GiB build reserve ` +
      `(${admission}); ${gib(thresholds.floorKiB)} GiB freeze / ` +
      `${gib(thresholds.resumeKiB)} GiB resume; timer enabled/active; ` +
      `workloads ${bothFrozen ? "frozen" : "running"}; last event ` +
      guardianEventSummary(observed.lastEvent),
  };
}

/** Turn file observations into the two operator-facing resource verdicts. PURE. */
export function assessBuildResources(
  p: Platform,
  policy: BuildResourcePolicy,
  observed: BuildResourceObservation,
): BuildResourceFinding[] {
  if (p.os !== "linux") {
    return [{ name: "build resources", status: "n/a", detail: "owned by the Linux/WSL side" }];
  }

  const cargoCurrent =
    observed.cargoDefaults === renderCargoDefaults(policy) &&
    observed.cargoHome?.includes(CARGO_INCLUDE) === true;
  const findings: BuildResourceFinding[] = [
    cargoCurrent
      ? {
          name: "Cargo resources",
          status: "ok",
          detail: `${policy.cargoJobs} compiler job(s), ${policy.rustTestThreads} libtest thread(s)`,
        }
      : {
          name: "Cargo resources",
          status: "drift",
          detail: "the low-priority Cargo resource layer is absent or stale",
          fix: "red-dev install core",
        },
  ];

  if (!p.caps.systemd) {
    findings.push({
      name: "heavy workload slice",
      status: "n/a",
      detail: "this Linux host has no systemd user manager",
    });
    return findings;
  }

  const isolation = workloadPolicy({
    totalMemoryBytes: observed.totalMemoryBytes,
    logicalCpus: observed.logicalCpus,
  });
  const sliceCurrent =
    observed.workloadShell === isolation.shell &&
    observed.diskGuardian === isolation.diskGuardian &&
    Object.entries(isolation.systemd).every(([path, content]) =>
      observed.systemd.some((entry) => entry.path === path && entry.content === content)
    );
  findings.push(
    sliceCurrent
      ? {
          name: "workload isolation",
          status: "ok",
          detail:
            `dynamic 80% wall (${isolation.capacity.memoryMax} memory, ` +
            `${isolation.capacity.cpuQuota} CPU); protected Zellij and bounded panes, agents and builds`,
        }
      : {
          name: "workload isolation",
          status: "drift",
          detail: "the aggregate cgroup or one of its workload attachments is absent or stale",
          fix: "red-dev install core",
        },
  );
  if (p.env === "wsl") {
    findings.push(assessHostDiskGuard(observed.hostDiskGuard));
    const hostPlan = wslHostConfigPlan(
      observed.wslConfig ?? null,
      observed.windowsLogicalCpus ?? observed.logicalCpus,
      observed.windowsPhysicalMemoryBytes ?? undefined,
    );
    findings.push(
      hostPlan.action === "current"
        ? {
            name: "WSL host resources",
            status: "ok",
            detail: "60% host RAM, CPU headroom, 4 GiB swap, one retained crash dump, cache reclaim",
          }
        : {
            name: "WSL host resources",
            status: "drift",
            detail: hostPlan.action === "blocked" ? hostPlan.reason : ".wslconfig is missing safe resource defaults",
            fix: "red-dev install core, then from PowerShell: wsl --shutdown",
          },
    );
  }
  return findings;
}

async function resourceObservation(home: string, p: Platform): Promise<BuildResourceObservation> {
  const read = async (path: string): Promise<string | null> =>
    existsSync(path) ? await file(path).text() : null;
  const systemd = `${home}/.config/systemd/user`;
  const totalMemoryBytes = totalmem();
  const logicalCpus = workloadLogicalCpuCount();
  const isolation = workloadPolicy({ totalMemoryBytes, logicalCpus });
  const systemdFiles = await Promise.all(
    Object.keys(isolation.systemd).map(async (path) => ({
      path,
      content: await read(`${systemd}/${path}`),
    })),
  );
  let wslConfig: string | null | undefined;
  let physicalMemoryBytes: number | null | undefined;
  let windowsLogicalCpus: number | null | undefined;
  let hostDiskGuard: HostDiskGuardObservation | undefined;
  if (p.env === "wsl") {
    try {
      wslConfig = await read(`${localPath(await windowsUserProfile(), "wsl")}/.wslconfig`);
    } catch {
      wslConfig = null;
    }
    try {
      physicalMemoryBytes = await windowsPhysicalMemoryBytes();
    } catch {
      physicalMemoryBytes = null;
    }
    try {
      windowsLogicalCpus = await windowsLogicalCpuCount();
    } catch {
      windowsLogicalCpus = null;
    }
    const [
      disk,
      timerEnabled,
      timerActive,
      serviceResult,
      serviceExitStatus,
      buildFreezerState,
      agentFreezerState,
    ] = await Promise.all([
      commandOutput(["df", "-Pk", "/mnt/c"]),
      commandOutput(["systemctl", "--user", "is-enabled", "red-dev-disk-guardian.timer"]),
      commandOutput(["systemctl", "--user", "is-active", "red-dev-disk-guardian.timer"]),
      commandOutput(["systemctl", "--user", "show", "red-dev-disk-guardian.service", "-p", "Result", "--value"]),
      commandOutput(["systemctl", "--user", "show", "red-dev-disk-guardian.service", "-p", "ExecMainStatus", "--value"]),
      commandOutput(["systemctl", "--user", "show", "red-dev-heavy-builds.slice", "-p", "FreezerState", "--value"]),
      commandOutput(["systemctl", "--user", "show", "red-dev-heavy-agents.slice", "-p", "FreezerState", "--value"]),
    ]);
    const diskUsage = disk?.code === 0 ? parseHostDiskDf(disk.output) : null;
    const exitStatus = serviceExitStatus?.output ?? "";
    hostDiskGuard = {
      totalKiB: diskUsage?.totalKiB ?? null,
      freeKiB: diskUsage?.freeKiB ?? null,
      timerEnabled: timerEnabled === null ? null : timerEnabled.output === "enabled",
      timerActive: timerActive === null ? null : timerActive.output === "active",
      serviceResult: serviceResult?.output || null,
      serviceExitStatus: /^\d+$/.test(exitStatus) ? Number(exitStatus) : null,
      buildFreezerState: buildFreezerState?.output || null,
      agentFreezerState: agentFreezerState?.output || null,
      frozenMarker: await read(`${home}/.local/state/red-dev/disk-guardian-frozen`),
      lastEvent: await read(`${home}/.local/state/red-dev/disk-guardian-last`),
    };
  }
  return {
    cargoDefaults: await read(`${home}/.config/red-dev/cargo.toml`),
    cargoHome: await read(`${home}/.cargo/config.toml`),
    workloadShell: await read(`${home}/.local/share/red-dev/config/bash/build-resources.sh`),
    diskGuardian: await read(`${home}/.local/share/red-dev/bin/disk-guardian.sh`),
    systemd: systemdFiles,
    totalMemoryBytes,
    logicalCpus,
    ...(windowsLogicalCpus === undefined ? {} : { windowsLogicalCpus }),
    ...(wslConfig === undefined ? {} : { wslConfig }),
    ...(physicalMemoryBytes === undefined ? {} : { windowsPhysicalMemoryBytes: physicalMemoryBytes }),
    ...(hostDiskGuard === undefined ? {} : { hostDiskGuard }),
  };
}

/** Read-only posture used by doctor. */
export async function inspectBuildResources(p: Platform): Promise<BuildResourceFinding[]> {
  const policy = buildResourcePolicy({
    totalMemoryBytes: totalmem(),
    logicalCpus: workloadLogicalCpuCount(),
  });
  return assessBuildResources(p, policy, await resourceObservation(userHome(), p));
}

async function convergeWslHostResources(p: Platform, logicalCpus: number): Promise<void> {
  if (p.env !== "wsl") return;
  let windowsHome: string;
  try {
    windowsHome = localPath(await windowsUserProfile(), "wsl");
  } catch {
    log.warn("could not locate the Windows profile; .wslconfig resource defaults were not changed");
    return;
  }
  const path = `${windowsHome}/.wslconfig`;
  const existing = existsSync(path) ? await file(path).text() : null;
  const physicalMemoryBytes = await windowsPhysicalMemoryBytes();
  const windowsCpus = await windowsLogicalCpuCount();
  if (physicalMemoryBytes === null) {
    log.warn("could not read Windows physical memory; the WSL memory cap was not changed");
  }
  const plan = wslHostConfigPlan(
    existing,
    windowsCpus ?? logicalCpus,
    physicalMemoryBytes ?? undefined,
  );
  if (plan.action === "blocked") {
    log.warn(plan.reason);
    return;
  }
  if (plan.action === "current") {
    log.skip("WSL host resource defaults already current");
    return;
  }
  if (existing !== null) {
    const backup = `${path}.red-dev-backup`;
    if (!existsSync(backup)) await write(backup, existing);
  }
  await write(path, plan.content);
  log.ok(`WSL host defaults added: ${plan.added.join(", ")}`);
  log.plain("       they take effect after the next `wsl --shutdown`; red-dev does not stop live sessions");
}

async function reloadUserUnits(): Promise<boolean> {
  const child = spawn(["systemctl", "--user", "daemon-reload"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await child.exited) === 0;
}

async function enableDiskGuardianTimer(): Promise<boolean> {
  const child = spawn([
    "systemctl", "--user", "enable", "--now", "red-dev-disk-guardian.timer",
  ], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await child.exited) === 0;
}

/**
 * Converge the host's safe build defaults and Linux cgroup hierarchy.
 *
 * Existing workloads are deliberately not restarted or moved. New shells use
 * the shipped wrappers, and new redskilled Workers match the prefix drop-in.
 */
export async function convergeBuildResources(
  p: Platform,
  facts: { totalMemoryBytes?: number; logicalCpus?: number } = {},
): Promise<void> {
  if (p.os !== "linux") {
    log.skip("build resources are managed inside Linux/WSL");
    return;
  }

  const home = userHome();
  const totalMemoryBytes = facts.totalMemoryBytes ?? totalmem();
  const logicalCpus = facts.logicalCpus ?? workloadLogicalCpuCount();
  const policy = buildResourcePolicy({
    totalMemoryBytes,
    logicalCpus,
  });
  const isolation = workloadPolicy({ totalMemoryBytes, logicalCpus });
  const managedDir = `${home}/.config/red-dev`;
  const cargoDir = `${home}/.cargo`;
  mkdirSync(managedDir, { recursive: true });
  mkdirSync(cargoDir, { recursive: true });

  const managedCargo = `${managedDir}/cargo.toml`;
  const cargoChanged = await writeIfChanged(managedCargo, renderCargoDefaults(policy));
  const cargoHome = `${cargoDir}/config.toml`;
  const existing = existsSync(cargoHome) ? await file(cargoHome).text() : null;
  const cargoPlan = cargoHomeConfigPlan(existing);
  if (cargoPlan.action === "blocked") {
    log.warn(cargoPlan.reason);
    log.plain(`       managed defaults are ready at ${managedCargo}`);
  } else if (cargoPlan.action === "write") {
    if (existing !== null) {
      const backup = `${cargoHome}.red-dev-backup`;
      if (!existsSync(backup)) await write(backup, existing);
    }
    await write(cargoHome, cargoPlan.content);
    log.ok(`Cargo bounded to ${policy.cargoJobs} compiler job(s), ${policy.rustTestThreads} libtest thread(s)`);
  } else if (cargoChanged) {
    log.ok(`Cargo defaults updated: ${policy.cargoJobs} compiler job(s), ${policy.rustTestThreads} libtest thread(s)`);
  } else {
    log.skip(`Cargo resources already bounded (${policy.cargoJobs} build / ${policy.rustTestThreads} test)`);
  }

  await convergeWslHostResources(p, logicalCpus);

  if (!p.caps.systemd) {
    log.warn("aggregate memory containment unavailable: this Linux host has no systemd user manager");
    return;
  }

  const systemd = `${home}/.config/systemd/user`;
  const units = Object.entries(isolation.systemd).map(([path, content]) =>
    [`${systemd}/${path}`, content] as const
  );
  const guardianDir = `${home}/.local/share/red-dev/bin`;
  const guardianPath = `${guardianDir}/disk-guardian.sh`;
  mkdirSync(guardianDir, { recursive: true });
  const guardianChanged = await writeIfChanged(guardianPath, isolation.diskGuardian);
  chmodSync(guardianPath, 0o755);

  let changed = guardianChanged ? 1 : 0;
  for (const [path, content] of units) {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    if (await writeIfChanged(path, content)) changed++;
  }
  if (!(await reloadUserUnits())) {
    log.warn("build resource files were written, but the systemd user manager did not reload them");
    return;
  }
  if (!(await enableDiskGuardianTimer())) {
    log.warn("disk guardian was installed, but its timer could not be enabled");
    return;
  }
  if (changed > 0) {
    log.ok("Zellij, panes, agents and builds now use separate cgroup budgets");
    log.plain(
      `       red-dev is capped at 80%: ${isolation.capacity.memoryMax} memory and ` +
        `${isolation.capacity.cpuQuota} CPU`,
    );
  } else {
    log.skip("heavy workload slice already current");
  }
}
