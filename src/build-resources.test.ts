import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import {
  buildResourcePolicy,
  assessBuildResources,
  cargoHomeConfigPlan,
  renderCargoDefaults,
  parseWindowsLogicalCpus,
  parseWindowsPhysicalMemory,
  hostDiskThresholds,
  recommendedWslMemoryMiB,
  recommendedWslProcessors,
  wslHostConfigPlan,
} from "./build-resources.ts";
import { workloadPolicy } from "./workload-policy.ts";

const GIB = 1024 ** 3;

const LINUX_SYSTEMD: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};

describe("build resource policy", () => {
  test("bounds this 16 GiB / 12-thread WSL host", () => {
    expect(buildResourcePolicy({ totalMemoryBytes: 16 * GIB, logicalCpus: 12 })).toEqual({
      cargoJobs: 4,
      rustTestThreads: 2,
      nextestThreads: 4,
    });
    // WSL reports slightly less than the configured nominal capacity.
    expect(buildResourcePolicy({ totalMemoryBytes: 15.5 * GIB, logicalCpus: 12 })).toEqual({
      cargoJobs: 4,
      rustTestThreads: 2,
      nextestThreads: 4,
    });
  });

  test("scales down on a small host and stops scaling at safe ceilings", () => {
    expect(buildResourcePolicy({ totalMemoryBytes: 8 * GIB, logicalCpus: 4 })).toEqual({
      cargoJobs: 2,
      rustTestThreads: 1,
      nextestThreads: 2,
    });
    expect(buildResourcePolicy({ totalMemoryBytes: 64 * GIB, logicalCpus: 32 })).toEqual({
      cargoJobs: 8,
      rustTestThreads: 4,
      nextestThreads: 8,
    });
  });

  test("renders low-priority Cargo defaults without changing profiles or target dirs", () => {
    const rendered = renderCargoDefaults({ cargoJobs: 4, rustTestThreads: 2, nextestThreads: 4 });
    expect(rendered).toContain("[build]");
    expect(rendered).toContain("jobs = 4");
    expect(rendered).toContain("RUST_TEST_THREADS = { value = \"2\", force = false }");
    expect(rendered).toContain("[cache]");
    expect(rendered).toContain('auto-clean-frequency = "1 day"');
    expect(rendered).not.toMatch(/^target-dir\s*=/m);
    expect(rendered).not.toMatch(/^incremental\s*=/m);
    expect(rendered).not.toMatch(/^rustflags\s*=/m);
  });
});
describe("Cargo user layer", () => {
  test("creates an including config on a fresh machine", () => {
    const plan = cargoHomeConfigPlan(null);
    expect(plan.action).toBe("write");
    expect(plan.content).toContain("../.config/red-dev/cargo.toml");
    expect(plan.content).toContain('include = ["../.config/red-dev/cargo.toml"]');
  });

  test("prepends the include while preserving an existing user config", () => {
    const existing = "[build]\njobs = 7\n";
    const plan = cargoHomeConfigPlan(existing);
    expect(plan.action).toBe("write");
    expect(plan.content).toEndWith(existing);
    expect(plan.content).toContain("../.config/red-dev/cargo.toml");
  });

  test("does not rewrite an include graph it cannot safely merge", () => {
    const existing = "include = [\"company.toml\"]\n";
    expect(cargoHomeConfigPlan(existing)).toEqual({
      action: "blocked",
      content: existing,
      reason: "Cargo config already declares include; add ../.config/red-dev/cargo.toml to that list",
    });
  });

  test("migrates red-dev's newer table include for stable Cargo compatibility", () => {
    const existing = "# red-dev:build-resources begin\ninclude = [{ path = \"../.config/red-dev/cargo.toml\", optional = true }]\n# red-dev:build-resources end\n";
    const plan = cargoHomeConfigPlan(existing);
    expect(plan.action).toBe("write");
    expect(plan.content).toContain('include = ["../.config/red-dev/cargo.toml"]');
    expect(plan.content).not.toContain("optional = true");
  });
});

describe("workload isolation", () => {
  test("doctor reports both layers from the same expected bytes", () => {
    const policy = { cargoJobs: 5, rustTestThreads: 2, nextestThreads: 5 };
    const isolation = workloadPolicy({ totalMemoryBytes: 20 * GIB, logicalCpus: 10 });
    expect(assessBuildResources(LINUX_SYSTEMD, policy, {
      cargoDefaults: renderCargoDefaults(policy),
      cargoHome: "include = [{ path = \"../.config/red-dev/cargo.toml\", optional = true }]\n",
      workloadShell: isolation.shell,
      diskGuardian: isolation.diskGuardian,
      systemd: Object.entries(isolation.systemd).map(([path, content]) => ({ path, content })),
      totalMemoryBytes: 20 * GIB,
      logicalCpus: 10,
      windowsLogicalCpus: 12,
      wslConfig: "[wsl2]\nmemory=19660MB\nprocessors=10\nswap=4GB\nmaxCrashDumpCount=1\n[experimental]\nautoMemoryReclaim=dropCache\n",
      windowsPhysicalMemoryBytes: 32 * GIB,
      hostDiskGuard: {
        totalKiB: 900 * 1024 ** 2,
        freeKiB: 35 * 1024 ** 2,
        timerEnabled: true,
        timerActive: true,
        serviceResult: "success",
        serviceExitStatus: 0,
        buildFreezerState: "running",
        agentFreezerState: "running",
        frozenMarker: null,
        lastEvent: "at=2026-08-25T10:00:00Z action=thawed reason=host-disk-recovered",
      },
    })).toEqual([
      { name: "Cargo resources", status: "ok", detail: "5 compiler job(s), 2 libtest thread(s)" },
      { name: "workload isolation", status: "ok", detail: "dynamic 80% wall (16G memory, 800% CPU); protected Zellij and bounded panes, agents and builds" },
      { name: "host disk guard", status: "ok", detail: "35 GiB free; 30 GiB build reserve (admission open); 20 GiB freeze / 30 GiB resume; timer enabled/active; workloads running; last event action=thawed reason=host-disk-recovered" },
      { name: "WSL host resources", status: "ok", detail: "60% host RAM, CPU headroom, 4 GiB swap, one retained crash dump, cache reclaim" },
    ]);
  });

  test("doctor reports a disabled disk guardian as drift", () => {
    const policy = { cargoJobs: 5, rustTestThreads: 2, nextestThreads: 5 };
    const isolation = workloadPolicy({ totalMemoryBytes: 20 * GIB, logicalCpus: 10 });
    const findings = assessBuildResources(LINUX_SYSTEMD, policy, {
      cargoDefaults: renderCargoDefaults(policy),
      cargoHome: `include = ["../.config/red-dev/cargo.toml"]\n`,
      workloadShell: isolation.shell,
      diskGuardian: isolation.diskGuardian,
      systemd: Object.entries(isolation.systemd).map(([path, content]) => ({ path, content })),
      totalMemoryBytes: 20 * GIB,
      logicalCpus: 10,
      hostDiskGuard: {
        totalKiB: 900 * 1024 ** 2,
        freeKiB: 100 * 1024 ** 2,
        timerEnabled: false,
        timerActive: false,
        serviceResult: "success",
        serviceExitStatus: 0,
        buildFreezerState: "running",
        agentFreezerState: "running",
        frozenMarker: null,
        lastEvent: null,
      },
    });

    expect(findings).toContainEqual({
      name: "host disk guard",
      status: "drift",
      detail: "disk guardian timer is disabled/inactive",
      fix: "red-dev install core",
    });
  });
});

test("host disk thresholds share the admission reserve and guardian hysteresis", () => {
  expect(hostDiskThresholds(900 * 1024 ** 2)).toEqual({
    reserveKiB: 30 * 1024 ** 2,
    floorKiB: 20 * 1024 ** 2,
    resumeKiB: 30 * 1024 ** 2,
  });
});

describe("WSL host config", () => {
  test("derives 60% of physical RAM in whole MiB", () => {
    expect(parseWindowsPhysicalMemory("34279841792\r\n")).toBe(34279841792);
    expect(parseWindowsPhysicalMemory("not memory")).toBeNull();
    expect(recommendedWslMemoryMiB(34279841792)).toBe(19615);
    expect(parseWindowsLogicalCpus("12\r\n")).toBe(12);
    expect(parseWindowsLogicalCpus("not cpus")).toBeNull();
  });

  test("leaves two logical CPUs for Windows and preserves operator values", () => {
    expect(recommendedWslProcessors(12)).toBe(10);
    const existing = "[wsl2]\nmemory=16GB\nswap=6GB\n\n[experimental]\nnetworkingMode=mirrored\n";
    const plan = wslHostConfigPlan(existing, 12, 34279841792);
    expect(plan.action).toBe("write");
    expect(plan.content).toContain("memory=19615MB");
    expect(plan.content).toContain("swap=6GB");
    expect(plan.content).toContain("processors=10");
    expect(plan.content).toContain("maxCrashDumpCount=1");
    expect(plan.content).toContain("networkingMode=mirrored");
    expect(plan.content).toContain("autoMemoryReclaim=dropCache");
  });

  test("does not touch an ambiguous duplicate-section file", () => {
    expect(wslHostConfigPlan("[wsl2]\nswap=4GB\n[wsl2]\nmemory=8GB\n", 8).action).toBe("blocked");
  });
});
