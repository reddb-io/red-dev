import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { runBounded, type BoundedCommandResult } from "./bounded-command.ts";
import type { Platform } from "./platform.ts";
import { readMachineProfile } from "./machine-profile.ts";
import { resourceRetirementPlan } from "./resource-retirement.ts";
import { powershellBin } from "./wsl.ts";
import type { ResourceSettings } from "./resource-settings.ts";
import { inspectBuildQueue, type BuildQueueEntry } from "./resource-build.ts";

export interface MemoryReading { total: number | null; available: number | null; swapTotal: number | null; swapFree: number | null; }
export interface BuildProcess { pid: number; name: string; rss: number | null; cwd: string | null; cgroup: string | null; }
export interface CgroupReading { path: string; max: string | null; high: string | null; swapMax: string | null; oomKills: number | null; }
export interface LinuxResources {
  memory: MemoryReading; pressure: { someAvg10: number | null; fullAvg10: number | null };
  swapCounters: { pagesIn: number | null; pagesOut: number | null };
  builds: BuildProcess[]; cgroups: CgroupReading[]; processObservationComplete: boolean;
}
export interface WindowsResources { total: number | null; available: number | null; commitUsed: number | null; commitLimit: number | null; }
export interface ResourceSnapshot {
  schema: 1; platform: string; linux: LinuxResources | null; windows: WindowsResources | null;
  choice: ResourceSettings | null;
  buildQueue: BuildQueueEntry[];
  wslBuildQueue?: BuildQueueEntry[];
  wslBuildSlots?: number;
  wsl: { path: string | null; source: string | null; memory: string | null; swap: string | null; runningDistro: string | null };
  legacy: Array<{ path: string; owned: boolean }>; unknown: string[];
}
function read(path: string): string | null { try { return readFileSync(path, "utf8"); } catch { return null; } }
function numeric(value: unknown): number | null { const n = Number(value); return (typeof value === "number" || typeof value === "string" && value.trim() !== "") && Number.isFinite(n) && n >= 0 ? n : null; }
export function meminfoBytes(text: string | null, field: string): number | null {
  const value = text && new RegExp(`^${field}:\\s+(\\d+)\\s+kB`, "m").exec(text)?.[1];
  return value ? Number(value) * 1024 : null;
}
function counter(text: string | null, name: string): number | null { return numeric(text ? new RegExp(`^${name}\\s+(\\d+)`, "m").exec(text)?.[1] : undefined); }
function psi(text: string | null, name: string): number | null { return numeric(text ? new RegExp(`^${name}\\s+avg10=([\\d.]+)`, "m").exec(text)?.[1] : undefined); }
export function inspectLinuxResources(procRoot = "/proc", cgroupRoot = "/sys/fs/cgroup", currentPid = process.pid): LinuxResources {
  const mem = read(join(procRoot, "meminfo")); const pressure = read(join(procRoot, "pressure/memory"));
  const builds: BuildProcess[] = []; const groups = new Set<string>(); let complete = true;
  const groupFor = (pid: number) => read(join(procRoot, String(pid), "cgroup"))?.split("\n").find(l => l.startsWith("0::"))?.slice(3) ?? null;
  const currentGroup = groupFor(currentPid); if (currentGroup) groups.add(currentGroup);
  let entries: string[] = [];
  try { entries = readdirSync(procRoot); } catch { complete = false; }
  for (const entry of entries.filter(e => /^\d+$/.test(e))) {
    const name = read(join(procRoot, entry, "comm"))?.trim();
    if (!name || !/^(cargo|rustc|rust-analyzer|mold|ld|ld\.lld|lld|clang|cc1)$/.test(name)) continue;
    let cwd: string | null = null;
    try { cwd = readlinkSync(join(procRoot, entry, "cwd")); } catch { complete = false; }
    const cgroup = groupFor(Number(entry)); if (cgroup) groups.add(cgroup);
    builds.push({ pid: Number(entry), name, rss: meminfoBytes(read(join(procRoot, entry, "status")), "VmRSS"), cwd, cgroup });
  }
  const paths = new Set<string>();
  for (const group of groups) {
    let path = resolve(cgroupRoot, `.${group}`); const root = resolve(cgroupRoot);
    const local = relative(root, path);
    if (local.startsWith("..") || isAbsolute(local)) continue;
    for (;;) { paths.add(path); if (path === root) break; path = dirname(path); }
  }
  const cgroups = [...paths].map(path => ({ path: path.slice(resolve(cgroupRoot).length).replaceAll("\\", "/") || "/",
    max: read(join(path, "memory.max"))?.trim() ?? null, high: read(join(path, "memory.high"))?.trim() ?? null,
    swapMax: read(join(path, "memory.swap.max"))?.trim() ?? null, oomKills: counter(read(join(path, "memory.events")), "oom_kill") }));
  return { memory: { total: meminfoBytes(mem, "MemTotal"), available: meminfoBytes(mem, "MemAvailable"), swapTotal: meminfoBytes(mem, "SwapTotal"), swapFree: meminfoBytes(mem, "SwapFree") },
    pressure: { someAvg10: psi(pressure, "some"), fullAvg10: psi(pressure, "full") },
    swapCounters: { pagesIn: counter(read(join(procRoot, "vmstat")), "pswpin"), pagesOut: counter(read(join(procRoot, "vmstat")), "pswpout") },
    builds: builds.sort((a, b) => (b.rss ?? 0) - (a.rss ?? 0)), cgroups, processObservationComplete: complete };
}
/** One read-only host probe; no directory cache or credential lookup. */
export const WINDOWS_RESOURCE_SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$os = Get-CimInstance Win32_OperatingSystem
$computer = Get-CimInstance Win32_ComputerSystem
$counter = $null
try { $counter = Get-CimInstance Win32_PerfFormattedData_PerfOS_Memory } catch {}
$path = Join-Path $env:USERPROFILE '.wslconfig'
$content = $null
if (Test-Path -LiteralPath $path -PathType Leaf) { $content = [Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) }
@{ total = [double]$computer.TotalPhysicalMemory; available = [double]$os.FreePhysicalMemory * 1024;
   commitUsed = $(if ($counter) { [double]$counter.CommittedBytes } else { $null });
   commitLimit = $(if ($counter) { [double]$counter.CommitLimit } else { $null });
   path = $path; content = $content } | ConvertTo-Json -Compress
`;
export function wslResourceValues(source: string | null): { memory: string | null; swap: string | null } {
  let section = ""; const values = { memory: null, swap: null } as { memory: string | null; swap: string | null };
  for (const line of source?.replace(/^\uFEFF/, "").split(/\r?\n/) ?? []) {
    const header = /^\s*\[([^\]]+)\]/.exec(line); if (header) { section = header[1]!.toLowerCase(); continue; }
    const row = /^\s*(memory|swap)\s*=\s*([^#;]+)/i.exec(line);
    if (section === "wsl2" && row) values[row[1]!.toLowerCase() as "memory" | "swap"] = row[2]!.trim();
  }
  return values;
}
type Run = (argv: string[]) => Promise<BoundedCommandResult>;
export async function resourceSnapshot(p: Platform, seams: { run?: Run; procRoot?: string; cgroupRoot?: string; home?: string } = {}): Promise<ResourceSnapshot> {
  const run: Run = seams.run ?? (argv => runBounded(argv, { timeoutMs: 8000, windowsOutput: argv[0] === "wsl.exe" }));
  const snapshot: ResourceSnapshot = { schema: 1, platform: `${p.os}/${p.env}`, linux: p.os === "linux" ? inspectLinuxResources(seams.procRoot, seams.cgroupRoot) : null,
    windows: null, choice: null, buildQueue: [], wsl: { path: null, source: null, memory: null, swap: null, runningDistro: null }, legacy: [], unknown: [] };
  try { snapshot.buildQueue = inspectBuildQueue(); } catch { snapshot.unknown.push("Participating build queue unreadable; capacity is not assumed free"); }
  try { snapshot.choice = readMachineProfile()?.resources ?? null; } catch { snapshot.unknown.push("Saved profile unreadable; existing configuration preserved"); }
  const remote = process.env.RED_DEV_RESOURCES_REMOTE === "1";
  if ((p.os === "windows" || p.env === "wsl") && !remote) {
    try {
      const result = await run([powershellBin(), "-NoProfile", "-NonInteractive", "-Command", WINDOWS_RESOURCE_SCRIPT]);
      if (result.exitCode !== 0 || result.timedOut) throw Error("Windows resource probe unavailable");
      const value = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
      snapshot.windows = { total: numeric(value.total), available: numeric(value.available), commitUsed: numeric(value.commitUsed), commitLimit: numeric(value.commitLimit) };
      if (typeof value.path !== "string" || !value.path) throw Error("Windows profile path unavailable");
      if (p.os === "windows") snapshot.wsl.path = value.path;
      else {
        const translated = await run(["wslpath", "-u", value.path]);
        if (translated.exitCode !== 0 || translated.timedOut || !translated.stdout.trim().startsWith("/")) throw Error("Windows config path translation unavailable");
        snapshot.wsl.path = translated.stdout.trim();
      }
      snapshot.wsl.source = typeof value.content === "string" ? Buffer.from(value.content, "base64").toString("utf8") : null;
      Object.assign(snapshot.wsl, wslResourceValues(snapshot.wsl.source));
    } catch { snapshot.unknown.push("Windows memory or .wslconfig unavailable; no host budget inferred from Linux memory"); }
  }
  if (p.os === "windows" && !remote) {
    try {
      const desired = readMachineProfile()?.distro ?? p.wslDistro;
      const listing = await run(["wsl.exe", "--list", "--running", "--quiet"]);
      if (listing.exitCode !== 0 || listing.timedOut) throw Error("WSL listing unavailable");
      const running = listing.stdout.replaceAll("\0", "").replace(/^\uFEFF/, "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      const distro = desired ? running.find(n => n === desired) : running.length === 1 ? running[0] : undefined;
      if (!distro) throw Error("selected WSL is stopped, unavailable or ambiguous");
      snapshot.wsl.runningDistro = distro;
      const child = await run(["wsl.exe", "--distribution", distro, "--exec", "sh", "-c",
        'export RED_DEV_RESOURCES_REMOTE=1; export PATH="$HOME/.local/share/mise/shims:$HOME/.local/bin:$PATH"; exec red-dev resources status --json']);
      if (child.exitCode !== 0 || child.timedOut) throw Error("WSL diagnostic command unavailable");
      const value = JSON.parse(child.stdout);
      if (value.schema !== 1 || !value.linux || !Array.isArray(value.linux.builds) || !Array.isArray(value.linux.cgroups)) throw Error("WSL diagnostic version unavailable");
      snapshot.linux = value.linux; snapshot.legacy.push(...(value.legacy ?? []));
      snapshot.wslBuildQueue = Array.isArray(value.buildQueue) ? value.buildQueue : [];
      snapshot.wslBuildSlots = value.choice?.buildSlots;
    } catch { snapshot.unknown.push("Linux telemetry unavailable; start the chosen distro and update its red-dev, then inspect again"); }
  }
  const home = seams.home ?? process.env.HOME ?? process.env.USERPROFILE;
  if (home) {
    try {
    const retired = resourceRetirementPlan(home, snapshot.wsl.path ?? undefined);
    snapshot.legacy.push(...retired.changes.map(e => ({ path: e.path, owned: true })), ...retired.preserved.map(path => ({ path, owned: false })));
    } catch { snapshot.unknown.push("Legacy resource definitions could not all be read; ownership remains unconfirmed"); }
  }
  if (snapshot.linux?.memory.total === null) snapshot.unknown.push("Linux memory unavailable");
  return snapshot;
}
export function gib(bytes: number | null): string { return bytes === null ? "unknown" : `${(bytes / 1024 ** 3).toFixed(1)} GiB`; }
function memoryLimit(value: string | null): string { return value === "max" ? "unlimited" : value !== null && /^\d+$/.test(value) ? gib(Number(value)) : "unknown"; }
export function resourceOverview(s: ResourceSnapshot): string[] {
  const lines = ["Resources", `Saved choice: ${s.choice?.mode ?? "system settings"}`];
  if (s.windows) lines.push(`Windows RAM: ${gib(s.windows.available)} available / ${gib(s.windows.total)} total`);
  if (s.linux) {
    const l = s.linux;
    lines.push(`Linux RAM: ${gib(l.memory.available)} available / ${gib(l.memory.total)} visible; swap ${gib(l.memory.swapTotal)} total`,
      `Memory pressure: ${l.pressure.fullAvg10 ?? "unknown"}% fully stalled over the last 10s`,
      `Rust processes: ${l.builds.filter(b => b.name === "cargo").length} Cargo, ${l.builds.filter(b => b.name === "rustc").length} rustc, ${l.builds.filter(b => b.name === "rust-analyzer").length} rust-analyzer`);
    const controls = l.cgroups.filter(c => c.max !== null && c.max !== "max" || c.high !== null && c.high !== "max");
    lines.push(controls.length ? `Inherited memory controls: ${controls.length} level(s); open Details to see their limits.` : "Open Details to inspect inherited controls and missing observations.");
  }
  if (s.wsl.path) lines.push(`Configured WSL: memory ${s.wsl.memory ?? "system default"}, swap ${s.wsl.swap ?? "system default"}; changes require a WSL restart.`);
  if (s.legacy.length) lines.push(`Legacy definitions: ${s.legacy.filter(e => e.owned).length} recognized, ${s.legacy.filter(e => !e.owned).length} with unknown ownership; inspect before cleanup.`);
  lines.push(...s.unknown.map(v => `Unknown: ${v}`));
  return lines;
}
export function resourceReport(s: ResourceSnapshot): string[] {
  const lines = ["Resources", `Saved choice: ${s.choice?.mode ?? "system settings (no explicit choice)"}`, "Current readings; configurations and running workloads are unchanged."];
  if (s.choice?.buildSlots) lines.push(`Build coordination: ${s.choice.buildSlots} slot(s), only for resources run in this environment.`);
  lines.push(...s.buildQueue.map(b => `Build slot ${b.slot}: ${b.phase}; runner=${b.runnerPid ?? "unknown"}, child=${b.childPid ?? "unknown"}, runner alive=${b.runnerAlive ?? "unknown"}`));
  if (s.wslBuildQueue) lines.push(`WSL participating build slots: ${s.wslBuildSlots ?? "system scheduling"}; ${s.wslBuildQueue.length} occupied slot(s)`);
  if (s.windows) lines.push(`Windows: ${gib(s.windows.available)} available / ${gib(s.windows.total)} total`, `Windows commit: ${gib(s.windows.commitUsed)} / ${gib(s.windows.commitLimit)}`);
  if (s.linux) {
    const l = s.linux;
    lines.push(`Linux${s.platform.includes("wsl") || s.wsl.runningDistro ? "/WSL" : ""}: ${gib(l.memory.available)} available / ${gib(l.memory.total)} visible`,
      `Swap: ${gib(l.memory.swapTotal !== null && l.memory.swapFree !== null ? l.memory.swapTotal - l.memory.swapFree : null)} used / ${gib(l.memory.swapTotal)}`,
      `Memory pressure (last 10s): some=${l.pressure.someAvg10 ?? "unknown"}%, full=${l.pressure.fullAvg10 ?? "unknown"}%`,
      `Swap pages since boot: in=${l.swapCounters.pagesIn ?? "unknown"}, out=${l.swapCounters.pagesOut ?? "unknown"}; these are cumulative counters`,
      "Build processes (RSS includes shared pages; rows are not a total):");
    lines.push(...l.builds.slice(0, 20).map(b => `  ${b.pid} ${b.name}: ${gib(b.rss)}${b.cwd ? `; ${b.cwd}` : ""}`));
    if (!l.builds.length) lines.push("  No Rust compiler, analyzer or linker observed.");
    lines.push("Memory controls on the current shell/build cgroups and their ancestors:", ...l.cgroups.map(c => `  ${c.path}: max=${memoryLimit(c.max)}, high=${memoryLimit(c.high)}, swap.max=${memoryLimit(c.swapMax)}, oom_kill=${c.oomKills ?? "unknown"}`));
    lines.push("oom_kill is cumulative and inherited levels can report the same event.");
    if (!l.cgroups.length || l.cgroups.every(c => c.max === null)) lines.push("Cgroup v2 memory controls unavailable; absence of limits is not confirmed.");
    if (!l.processObservationComplete) lines.push("Some process details were not readable.");
  }
  if (s.wsl.path) lines.push(`WSL config: ${s.wsl.path}`, `  memory=${s.wsl.memory ?? "system default"}; swap=${s.wsl.swap ?? "system default"}`, "  This ceiling covers the WSL VM, shared by WSL 2 distributions; it does not reserve Windows memory.");
  lines.push(...s.legacy.map(e => `Legacy: ${e.owned ? "recognized red-dev definition" : "preserved unknown owner"}; ${e.path}`), ...s.unknown.map(v => `Unknown: ${v}`));
  return lines;
}
