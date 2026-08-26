import { totalmem } from "node:os";
import {
  buildResourcePolicy,
  parseHostDiskDf,
  recommendedWslMemoryMiB,
  recommendedWslProcessors,
} from "./build-resources.ts";
import { runBounded } from "./bounded-command.ts";
import type { Platform } from "./platform.ts";
import type { Choice } from "./tui-setup-model.ts";
import {
  hostDiskThresholds,
  workloadLogicalCpuCount,
  workloadPolicy,
} from "./workload-policy.ts";
import { powershellBin } from "./wsl.ts";

const GIB = 1024 ** 3;
const GIB_KIB = 1024 ** 2;

export interface WslTuningFacts {
  windowsMemoryBytes: number;
  windowsLogicalCpus: number;
  workloadMemoryBytes: number;
  workloadLogicalCpus: number;
  hostDiskTotalKiB: number;
  /** False means the host values below are fallback inputs, not observations. */
  hostMeasured?: boolean;
  /** False means only the documented disk formulas are known. */
  hostDiskMeasured?: boolean;
}

async function processText(argv: readonly string[]): Promise<string | null> {
  try {
    const result = await runBounded([...argv], { timeoutMs: 1_500, killGraceMs: 200 });
    return !result.timedOut && result.exitCode === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}

async function observedHostDisk(p: Platform): Promise<{ totalKiB: number; measured: boolean }> {
  if (p.env === "wsl") {
    const output = await processText(["df", "-Pk", "/mnt/c"]);
    const totalKiB = output ? parseHostDiskDf(output)?.totalKiB ?? 0 : 0;
    return { totalKiB, measured: totalKiB > 0 };
  }
  if (p.os === "windows") {
    const output = await processText([
      powershellBin(),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$d=$env:SystemDrive; [int64](Get-CimInstance Win32_LogicalDisk -Filter \"DeviceID='$d'\").Size",
    ]);
    const bytes = output && /^\d+$/.test(output) ? Number(output) : 0;
    const totalKiB = Number.isSafeInteger(bytes) && bytes > 0 ? Math.floor(bytes / 1024) : 0;
    return { totalKiB, measured: totalKiB > 0 };
  }
  return { totalKiB: 0, measured: false };
}

/** Facts available while the installer is still only interviewing the machine. */
export async function observeWslTuningFacts(p: Platform): Promise<WslTuningFacts> {
  const currentMemory = totalmem();
  const currentCpus = workloadLogicalCpuCount();
  let windowsMemory = currentMemory;
  let windowsCpus = currentCpus;
  let workloadMemory = currentMemory;
  let workloadCpus = currentCpus;
  let hostMeasured = p.os === "windows";

  if (p.env === "wsl") {
    const host = await processText([
      powershellBin(),
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$c=Get-CimInstance Win32_ComputerSystem; \"$([int64]$c.TotalPhysicalMemory)|$([int]$c.NumberOfLogicalProcessors)\"",
    ]);
    const [memoryText, cpuText] = host?.split("|") ?? [];
    const measuredMemory = memoryText && /^\d+$/.test(memoryText) ? Number(memoryText) : 0;
    const measuredCpus = cpuText && /^\d+$/.test(cpuText) ? Number(cpuText) : 0;
    hostMeasured = Number.isSafeInteger(measuredMemory) && measuredMemory > 0 &&
      Number.isSafeInteger(measuredCpus) && measuredCpus > 0;
    if (Number.isSafeInteger(measuredMemory) && measuredMemory > 0) {
      windowsMemory = measuredMemory;
    } else {
      windowsMemory = Math.floor(currentMemory / 0.6);
    }
    windowsCpus = Number.isSafeInteger(measuredCpus) && measuredCpus > 0
      ? measuredCpus
      : currentCpus + 2;
  } else if (p.os === "windows") {
    workloadMemory = recommendedWslMemoryMiB(windowsMemory) * 1024 ** 2;
    workloadCpus = recommendedWslProcessors(windowsCpus);
  }

  const hostDisk = await observedHostDisk(p);
  return {
    windowsMemoryBytes: windowsMemory,
    windowsLogicalCpus: windowsCpus,
    workloadMemoryBytes: workloadMemory,
    workloadLogicalCpus: workloadCpus,
    hostDiskTotalKiB: hostDisk.totalKiB,
    hostMeasured,
    hostDiskMeasured: hostDisk.measured,
  };
}

function gib(bytes: number): string {
  const value = bytes / GIB;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** User-facing inventory derived from the same policies the converge applies. */
export function wslTuningChoices(facts: WslTuningFacts): Choice[] {
  const wslMemoryBytes = recommendedWslMemoryMiB(facts.windowsMemoryBytes) * 1024 ** 2;
  const wslCpus = recommendedWslProcessors(facts.windowsLogicalCpus);
  const isolation = workloadPolicy({
    totalMemoryBytes: facts.workloadMemoryBytes,
    logicalCpus: facts.workloadLogicalCpus,
  });
  const rust = buildResourcePolicy({
    totalMemoryBytes: facts.workloadMemoryBytes,
    logicalCpus: facts.workloadLogicalCpus,
  });
  const disk = hostDiskThresholds(facts.hostDiskTotalKiB);
  const diskGiB = (kib: number): number => Math.floor(kib / GIB_KIB);
  const hostNote = facts.hostMeasured === false
    ? "60% Windows RAM · leave 2 CPUs · 4 GiB swap"
    : `${gib(wslMemoryBytes)}/${gib(facts.windowsMemoryBytes)} GiB RAM · ` +
      `${wslCpus}/${facts.windowsLogicalCpus} CPUs · 4 GiB swap`;
  const diskNote = facts.hostDiskMeasured === false
    ? "build reserve max(30 GiB, 3% of C:); freeze max(20 GiB, 2%); " +
      "resume max(30 GiB, 3%)"
    : `admit at ${diskGiB(disk.reserveKiB)} GiB free, ` +
      `freeze at ${diskGiB(disk.floorKiB)} GiB, ` +
      `resume at ${diskGiB(disk.resumeKiB)} GiB`;

  return [
    {
      key: "host",
      label: "Windows headroom",
      note: hostNote,
      selectable: false,
      marker: "included",
    },
    {
      key: "wall",
      label: "Workload wall",
      note: `${isolation.capacity.memoryMax} RAM / ${isolation.capacity.cpuQuota} CPU; ` +
        "Zellij and redskilled stay protected",
      selectable: false,
      marker: "included",
    },
    {
      key: "launch",
      label: "Per launch",
      note: `pane ${isolation.capacity.paneMemoryMax}, ` +
        `agent ${isolation.capacity.agentMemoryMax}, ` +
        `build ${isolation.capacity.buildMemoryMax}; hard walls avoid reclaim stalls`,
      selectable: false,
      marker: "included",
    },
    {
      key: "rust",
      label: "Rust",
      note: `Cargo ${rust.cargoJobs} jobs, libtest ${rust.rustTestThreads} threads, ` +
        `nextest ${rust.nextestThreads} threads`,
      selectable: false,
      marker: "included",
    },
    {
      key: "disk",
      label: "Windows disk",
      note: diskNote,
      selectable: false,
      marker: "included",
    },
    {
      key: "activation",
      label: "Activation · wsl --shutdown",
      note: "host limits apply on the next start",
      selectable: false,
      marker: "included",
    },
  ];
}
