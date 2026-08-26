import { readFileSync } from "node:fs";
import { totalmem } from "node:os";
import type { Platform } from "./platform.ts";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const GIB_KIB = 1024 ** 2;
const DOCUMENTATION = "https://github.com/reddb-io/red-dev";
const HOST_DISK_RESERVE_GIB = 30;
const HOST_DISK_RESERVE_PERCENT = 3;
const HOST_DISK_FLOOR_GIB = 20;
const HOST_DISK_FLOOR_PERCENT = 2;
const HOST_DISK_RESUME_GIB = 30;
const HOST_DISK_RESUME_PERCENT = 3;

export type WorkloadKind = "control" | "pane" | "agent" | "build";

export interface WorkloadPolicyFacts {
  totalMemoryBytes: number;
  logicalCpus: number;
}
export interface HostDiskThresholds {
  reserveKiB: number;
  floorKiB: number;
  resumeKiB: number;
}

/** Build admission and circuit-breaker thresholds derived from the same policy. PURE. */
export function hostDiskThresholds(totalKiB: number): HostDiskThresholds {
  const total = Number.isFinite(totalKiB) && totalKiB > 0 ? Math.floor(totalKiB) : 0;
  return {
    reserveKiB: Math.max(
      HOST_DISK_RESERVE_GIB * GIB_KIB,
      Math.floor(total * HOST_DISK_RESERVE_PERCENT / 100),
    ),
    floorKiB: Math.max(
      HOST_DISK_FLOOR_GIB * GIB_KIB,
      Math.floor(total * HOST_DISK_FLOOR_PERCENT / 100),
    ),
    resumeKiB: Math.max(
      HOST_DISK_RESUME_GIB * GIB_KIB,
      Math.floor(total * HOST_DISK_RESUME_PERCENT / 100),
    ),
  };
}

interface ResourceDomain {
  slice: string;
  description: string;
  aggregate: Readonly<Record<string, string>>;
  scope?: Readonly<Record<string, string>>;
  commandPrefix?: readonly string[];
}

interface ResourceDomains {
  root: ResourceDomain;
  control: ResourceDomain;
  work: ResourceDomain;
  pane: ResourceDomain;
  agent: ResourceDomain;
  build: ResourceDomain;
}

const AGENT_COMMANDS = "claude codex opencode redcode gemini pi hermes muse";
const BUILD_COMMANDS = "cargo rustc cmake ctest make ninja gcc g++ clang clang++ bun pnpm npm";

export function workloadLogicalCpuCount(): number {
  try {
    let count = 0;
    for (const line of readFileSync("/proc/cpuinfo", "utf8").split("\n")) {
      if (/^processor\s*:/.test(line)) count++;
    }
    if (count > 0) return count;
  } catch {
    // Native Windows has no /proc; its process environment carries this.
  }
  const reported = Number(process.env["NUMBER_OF_PROCESSORS"] ?? "1");
  return Number.isFinite(reported) && reported > 0 ? Math.floor(reported) : 1;
}

function formatMiB(value: number): string {
  return value % 1024 === 0 ? `${value / 1024}G` : `${value}M`;
}

function resourceDomains(facts: WorkloadPolicyFacts): ResourceDomains {
  const totalMiB = Math.max(1024, Math.floor(facts.totalMemoryBytes / MIB));
  const nominalGiB = Math.max(1, Math.round(facts.totalMemoryBytes / GIB));
  const cpus = Math.max(1, Math.floor(facts.logicalCpus));
  const rootMemory = (fraction: number): string =>
    formatMiB(Math.max(512, Math.floor(totalMiB * fraction)));
  const memory = (fraction: number, rounding: "ceil" | "floor" = "ceil"): string => {
    const amount = rounding === "ceil"
      ? Math.ceil(nominalGiB * fraction)
      : Math.floor(nominalGiB * fraction);
    return `${Math.max(1, amount)}G`;
  };
  const cpu = (fraction: number): string =>
    `${Math.max(1, Math.floor(cpus * 100 * fraction))}%`;

  return {
    root: {
      slice: "red-dev.slice",
      description: "red-dev global workstation budget",
      aggregate: {
        MemoryHigh: rootMemory(0.7),
        MemoryMax: rootMemory(0.8),
        MemorySwapMax: "512M",
        TasksMax: "12288",
        CPUQuota: cpu(0.8),
        CPUWeight: "100",
        IOWeight: "100",
      },
    },
    control: {
      slice: "red-dev-interactive.slice",
      description: "red-dev protected interactive control plane",
      aggregate: {
        MemoryLow: memory(0.1),
        MemoryHigh: memory(0.15),
        MemoryMax: memory(0.2),
        MemorySwapMax: "0",
        TasksMax: "2048",
        CPUWeight: "1000",
        IOWeight: "1000",
      },
    },
    work: {
      slice: "red-dev-heavy.slice",
      description: "red-dev bounded development work plane",
      aggregate: {
        MemoryHigh: memory(0.55, "floor"),
        MemoryMax: memory(0.65, "floor"),
        MemorySwapMax: "512M",
        TasksMax: "8192",
        CPUQuota: cpu(0.7),
        CPUWeight: "50",
        IOWeight: "50",
      },
    },
    pane: {
      slice: "red-dev-heavy-panes.slice",
      description: "red-dev interactive pane workloads",
      aggregate: {
        MemoryHigh: memory(0.2),
        MemoryMax: memory(0.3),
        MemorySwapMax: "0",
        TasksMax: "4096",
        CPUQuota: cpu(0.5),
        CPUWeight: "100",
        IOWeight: "100",
      },
      scope: {
        CPUQuota: cpu(0.3),
        CPUWeight: "100",
        IOWeight: "100",
        MemoryHigh: memory(0.1),
        MemoryMax: memory(0.15),
        MemorySwapMax: "0",
        TasksMax: "2048",
        OOMPolicy: "continue",
      },
    },
    agent: {
      slice: "red-dev-heavy-agents.slice",
      description: "red-dev coding agents",
      aggregate: {
        MemoryHigh: memory(0.3),
        MemoryMax: memory(0.4),
        MemorySwapMax: "256M",
        TasksMax: "4096",
        CPUQuota: cpu(0.5),
        CPUWeight: "200",
        IOWeight: "100",
      },
      scope: {
        CPUQuota: cpu(0.25),
        CPUWeight: "200",
        IOWeight: "100",
        MemoryHigh: memory(0.2),
        MemoryMax: memory(0.25),
        MemorySwapMax: "128M",
        TasksMax: "2048",
        OOMPolicy: "continue",
      },
    },
    build: {
      slice: "red-dev-heavy-builds.slice",
      description: "red-dev builds and tests",
      aggregate: {
        MemoryHigh: memory(0.3),
        MemoryMax: memory(0.4),
        MemorySwapMax: "256M",
        TasksMax: "4096",
        CPUQuota: cpu(0.5),
        CPUWeight: "50",
        IOWeight: "25",
      },
      scope: {
        CPUQuota: cpu(0.5),
        CPUWeight: "50",
        IOWeight: "25",
        MemoryHigh: memory(0.25),
        MemoryMax: memory(0.4),
        MemorySwapMax: "128M",
        TasksMax: "2048",
        OOMPolicy: "continue",
      },
      commandPrefix: ["nice", "-n", "10"],
    },
  };
}

function renderSlice(domain: ResourceDomain): string {
  const properties = Object.entries(domain.aggregate).map(([key, value]) => `${key}=${value}`);
  return `[Unit]
Description=${domain.description}
Documentation=${DOCUMENTATION}

[Slice]
${properties.join("\n")}
`;
}

function renderAttachment(
  section: "Service" | "Scope",
  domain: ResourceDomain,
  includeScopeLimits: boolean,
): string {
  const limits = includeScopeLimits
    ? Object.entries(domain.scope ?? {}).map(([key, value]) => `${key}=${value}`)
    : [];
  return `# Managed by red-dev.
[${section}]
Slice=${domain.slice}
${limits.length > 0 ? `${limits.join("\n")}\n` : ""}`;
}

const SCOPE_GUARD = `expected_slice=$1
kind=$2
shift 2
if ! red_dev_cgroup=$(cat /proc/self/cgroup 2>/dev/null); then
  printf 'red-dev: cannot verify %s workload cgroup; refusing launch\n' "$kind" >&2
  exit 125
fi
case "$red_dev_cgroup" in
  *"/$expected_slice/"*|*"/$expected_slice") red_dev_result=accepted ;;
  *)
    printf 'red-dev: %s workload entered the wrong cgroup; expected %s, got %s\n' \
      "$kind" "$expected_slice" "$red_dev_cgroup" >&2
    red_dev_result=refused
    ;;
esac
red_dev_path=\${red_dev_cgroup#*::}
red_dev_unit=\${red_dev_path##*/}
red_dev_workload_id=\${red_dev_unit%.scope}
red_dev_state=\${XDG_STATE_HOME:-$HOME/.local/state}/red-dev
if mkdir -p "$red_dev_state" 2>/dev/null; then
  printf 'at=%s workload_id=%s pid=%s kind=%s unit=%s result=%s cgroup=%s\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$red_dev_workload_id" "$$" "$kind" \
    "$red_dev_unit" "$red_dev_result" "$red_dev_cgroup" \
    >>"$red_dev_state/workloads.log" 2>/dev/null || true
fi
if [ "$red_dev_result" != accepted ]; then exit 125; fi
exec "$@"`;

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:=+%@,-]+$/.test(value)
    ? value
    : `'${value.split("'").join(`'"'"'`)}'`;
}

function scopeArgv(kind: WorkloadKind, domain: ResourceDomain, argv: readonly string[]): string[] {
  const properties = Object.entries(domain.scope ?? {}).map(([key, value]) =>
    `--property=${key}=${value}`
  );
  return [
    "systemd-run", "--user", "--scope", "--quiet", "--collect",
    `--slice=${domain.slice}`,
    ...properties,
    "--",
    "sh",
    "-c",
    SCOPE_GUARD,
    "red-dev-workload-guard",
    domain.slice,
    kind,
    ...(domain.commandPrefix ?? []),
    ...argv,
  ];
}

function renderShell(domains: ResourceDomains): string {
  const command = (kind: WorkloadKind, domain: ResourceDomain): string =>
    scopeArgv(kind, domain, []).map(shellQuote).join(" ");
  return `# Managed by red-dev. Generated from the Workload Policy.
# Zellij, ordinary panes, agents and builds each enter the resource domain
# declared in one policy. Workloads do not run when containment cannot be proven.

_red_dev_systemd_ready() {
  [ "\${RED_ENV:-server}" != "windows" ] &&
    command -v systemd-run >/dev/null 2>&1 &&
    { [ -S "/run/user/$(id -u)/systemd/private" ] ||
      { [ -n "\${XDG_RUNTIME_DIR:-}" ] && [ -S "$XDG_RUNTIME_DIR/systemd/private" ]; }; }
}

_red_dev_guard_unavailable() {
  printf 'red-dev: user systemd is unavailable; refusing uncontained %s workload\n' "$1" >&2
  return 125
}

_red_dev_host_disk_ready() {
  [ "\${RED_ENV:-server}" = "wsl" ] || return 0
  _red_dev_disk_line=$(command df -Pk /mnt/c 2>/dev/null | command tail -n 1) ||
    _red_dev_disk_line=
  set -- $_red_dev_disk_line
  _red_dev_disk_total_kib=\${2:-}
  _red_dev_disk_free_kib=\${4:-}
  case "$_red_dev_disk_total_kib:$_red_dev_disk_free_kib" in
    *[!0-9:]*|:*|*:)
      printf 'red-dev: cannot verify Windows host disk reserve; refusing build\n' >&2
      return 125
      ;;
  esac
  _red_dev_disk_reserve_kib=$((${HOST_DISK_RESERVE_GIB} * 1024 * 1024))
  _red_dev_disk_percent_kib=$((_red_dev_disk_total_kib * ${HOST_DISK_RESERVE_PERCENT} / 100))
  if [ "$_red_dev_disk_percent_kib" -gt "$_red_dev_disk_reserve_kib" ]; then
    _red_dev_disk_reserve_kib=$_red_dev_disk_percent_kib
  fi
  if [ "$_red_dev_disk_free_kib" -lt "$_red_dev_disk_reserve_kib" ]; then
    printf 'red-dev: Windows host disk reserve reached: %s GiB free, %s GiB required; refusing build\n' \
      "$((_red_dev_disk_free_kib / 1024 / 1024))" \
      "$((_red_dev_disk_reserve_kib / 1024 / 1024))" >&2
    return 125
  fi
  unset _red_dev_disk_line _red_dev_disk_total_kib _red_dev_disk_free_kib
  unset _red_dev_disk_reserve_kib _red_dev_disk_percent_kib
}

_red_dev_run_control() {
  if [ "\${RED_ENV:-server}" = "windows" ]; then
    command "$@"
    return $?
  fi
  if ! _red_dev_systemd_ready; then
    _red_dev_guard_unavailable control
    return 125
  fi
  ${command("control", domains.control)} "$@"
}

_red_dev_run_agent() {
  if [ "\${RED_ENV:-server}" = "windows" ] || [ "\${RED_DEV_HEAVY_SCOPE:-1}" != "1" ]; then
    command "$@"
    return $?
  fi
  if ! _red_dev_systemd_ready; then
    _red_dev_guard_unavailable agent
    return 125
  fi
  ${command("agent", domains.agent)} "$@"
}

_red_dev_run_build() {
  _red_dev_host_disk_ready || return $?
  if [ "\${RED_ENV:-server}" = "windows" ] || [ "\${RED_DEV_HEAVY_SCOPE:-1}" != "1" ]; then
    command "$@"
    return $?
  fi
  if ! _red_dev_systemd_ready; then
    _red_dev_guard_unavailable build
    return 125
  fi
  ${command("build", domains.build)} "$@"
}

if [ -n "\${ZELLIJ:-}" ] &&
  [ "\${RED_DEV_PANE_SCOPED:-0}" != "1" ] &&
  [ "\${RED_DEV_PANE_SCOPE:-1}" = "1" ]; then
  if ! _red_dev_systemd_ready; then
    _red_dev_guard_unavailable pane
    exit 125
  fi
  RED_DEV_PANE_SCOPED=1 ${command("pane", domains.pane)} bash
  _red_dev_pane_status=$?
  if [ "$_red_dev_pane_status" -ne 0 ]; then
    printf 'red-dev: pane resource guard failed (%s) — closing this pane\n' \
      "$_red_dev_pane_status" >&2
  fi
  exit "$_red_dev_pane_status"
fi

_red_dev_define_workload_command() {
  declare -F "$1" >/dev/null 2>&1 && return 0
  alias "$1" >/dev/null 2>&1 && return 0
  command -v "$1" >/dev/null 2>&1 || return 0
  eval "function $1 { _red_dev_run_$2 '$1' \\\"\\$@\\\"; }"
}

for _red_dev_workload_command in ${AGENT_COMMANDS}; do
  _red_dev_define_workload_command "$_red_dev_workload_command" agent
done
for _red_dev_workload_command in ${BUILD_COMMANDS}; do
  _red_dev_define_workload_command "$_red_dev_workload_command" build
done
unset _red_dev_workload_command
unset -f _red_dev_define_workload_command
`;
}

function renderDiskGuardian(): string {
  return `#!/bin/sh
# Managed by red-dev. Keeps the Windows host away from disk exhaustion while
# preserving the interactive Zellij control plane and ordinary pane shells.
state_dir=\${XDG_STATE_HOME:-$HOME/.local/state}/red-dev
state_file=$state_dir/disk-guardian-frozen
last_file=$state_dir/disk-guardian-last
workload_log=$state_dir/workloads.log
mkdir -p "$state_dir" 2>/dev/null || exit 125

disk_line=$(command df -Pk /mnt/c 2>/dev/null | command tail -n 1) || disk_line=
set -- $disk_line
disk_total_kib=\${2:-}
disk_free_kib=\${4:-}
case "$disk_total_kib:$disk_free_kib" in
  *[!0-9:]*|:*|*:)
    disk_action=freeze
    disk_reason=host-disk-unavailable
    ;;
  *)
    disk_floor_kib=$((${HOST_DISK_FLOOR_GIB} * 1024 * 1024))
    disk_floor_percent_kib=$((disk_total_kib * ${HOST_DISK_FLOOR_PERCENT} / 100))
    [ "$disk_floor_percent_kib" -le "$disk_floor_kib" ] ||
      disk_floor_kib=$disk_floor_percent_kib
    disk_resume_kib=$((${HOST_DISK_RESUME_GIB} * 1024 * 1024))
    disk_resume_percent_kib=$((disk_total_kib * ${HOST_DISK_RESUME_PERCENT} / 100))
    [ "$disk_resume_percent_kib" -le "$disk_resume_kib" ] ||
      disk_resume_kib=$disk_resume_percent_kib
    if [ "$disk_free_kib" -lt "$disk_floor_kib" ]; then
      disk_action=freeze
      disk_reason=host-disk-critical
    elif [ "$disk_free_kib" -ge "$disk_resume_kib" ]; then
      disk_action=thaw
      disk_reason=host-disk-recovered
    else
      disk_action=hold
    fi
    ;;
esac

case "$disk_action" in
  freeze)
    command systemctl --user freeze \
      red-dev-heavy-builds.slice red-dev-heavy-agents.slice >/dev/null 2>&1 || exit 125
    if [ ! -e "$state_file" ]; then
      event_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      printf 'at=%s free_kib=%s action=frozen reason=%s\n' \
        "$event_at" "\${disk_free_kib:-unknown}" "$disk_reason" >"$state_file" || exit 125
      printf 'at=%s free_kib=%s action=frozen reason=%s\n' \
        "$event_at" "\${disk_free_kib:-unknown}" "$disk_reason" >"$last_file" || exit 125
      printf 'at=%s kind=disk-guardian result=frozen reason=%s free_kib=%s\n' \
        "$event_at" "$disk_reason" "\${disk_free_kib:-unknown}" >>"$workload_log" 2>/dev/null || true
    fi
    ;;
  hold)
    if [ -e "$state_file" ]; then
      command systemctl --user freeze \
        red-dev-heavy-builds.slice red-dev-heavy-agents.slice >/dev/null 2>&1 || exit 125
    fi
    ;;
  thaw)
    command systemctl --user thaw \
      red-dev-heavy-builds.slice red-dev-heavy-agents.slice >/dev/null 2>&1 || exit 125
    if [ -e "$state_file" ]; then
      event_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      printf 'at=%s free_kib=%s action=thawed reason=%s\n' \
        "$event_at" "\${disk_free_kib:-unknown}" "$disk_reason" >"$last_file" || exit 125
      printf 'at=%s kind=disk-guardian result=thawed reason=%s free_kib=%s\n' \
        "$event_at" "$disk_reason" "\${disk_free_kib:-unknown}" >>"$workload_log" 2>/dev/null || true
      rm -f "$state_file"
    fi
    ;;
esac
`;
}

export interface WorkloadPolicy {
  /** Exact systemd bytes owned by red-dev, keyed below the user unit directory. */
  systemd: Readonly<Record<string, string>>;
  /** Shell adapter installed before Zellij and expensive tool activation. */
  shell: string;
  /** Periodic host-disk circuit breaker run from the protected control plane. */
  diskGuardian: string;
  /** The global wall shown by doctor and status surfaces. */
  capacity: { memoryMax: string; cpuQuota: string };
  /** Launch a workload through its cgroup adapter when the platform supports it. */
  launch(kind: WorkloadKind, argv: readonly string[], p: Platform): string[];
}

/**
 * The workstation's single workload-isolation policy.
 *
 * The Interface is rendered files and launch argv. All cgroup names and limits
 * remain private so shell, systemd, agents, convergence and doctor cannot drift.
 */
export function workloadPolicy(
  facts: WorkloadPolicyFacts = {
    totalMemoryBytes: totalmem(),
    logicalCpus: workloadLogicalCpuCount(),
  },
): WorkloadPolicy {
  const domains = resourceDomains(facts);
  return {
    systemd: {
      [domains.root.slice]: renderSlice(domains.root),
      [domains.work.slice]: renderSlice(domains.work),
      [domains.control.slice]: renderSlice(domains.control),
      [domains.pane.slice]: renderSlice(domains.pane),
      [domains.agent.slice]: renderSlice(domains.agent),
      [domains.build.slice]: renderSlice(domains.build),
      "redskilled.service.d/50-red-dev-heavy-slice.conf":
        renderAttachment("Service", domains.control, false),
      "red-worker-.service.d/50-red-dev-heavy-slice.conf":
        renderAttachment("Service", domains.agent, true),
      "red-fleet-.scope.d/50-red-dev-heavy-slice.conf":
        renderAttachment("Scope", domains.agent, false),
      "red-dev-disk-guardian.service": `# Managed by red-dev.
[Unit]
Description=red-dev Windows host disk guardian
Documentation=${DOCUMENTATION}

[Service]
Type=oneshot
Slice=${domains.control.slice}
ExecStart=%h/.local/share/red-dev/bin/disk-guardian.sh
`,
      "red-dev-disk-guardian.timer": `# Managed by red-dev.
[Unit]
Description=Poll the Windows host disk before builds can exhaust it
Documentation=${DOCUMENTATION}

[Timer]
OnBootSec=15s
OnUnitActiveSec=10s
AccuracySec=1s
Unit=red-dev-disk-guardian.service

[Install]
WantedBy=timers.target
`,
    },
    shell: renderShell(domains),
    diskGuardian: renderDiskGuardian(),
    capacity: {
      memoryMax: domains.root.aggregate["MemoryMax"] ?? "unknown",
      cpuQuota: domains.root.aggregate["CPUQuota"] ?? "unknown",
    },
    launch(kind, argv, p) {
      if (p.os !== "linux" || !p.caps.systemd) return [...argv];
      const domain = {
        control: domains.control,
        pane: domains.pane,
        agent: domains.agent,
        build: domains.build,
      }[kind];
      return scopeArgv(kind, domain, argv);
    },
  };
}
