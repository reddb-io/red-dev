import { describe, expect, test } from "bun:test";
import { renderToString } from "tuiuiu.js";
import { buildSetupSteps } from "./firstrun.ts";
import type { Platform } from "./platform.ts";
import { questions, SetupLayout, type SetupModel } from "./tui-setup-model.ts";
import { wslTuningChoices } from "./wsl-tuning.ts";

const GIB = 1024 ** 3;

const WSL: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};

const WINDOWS: Platform = {
  os: "windows",
  distro: "windows",
  version: "11",
  codename: "",
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

const DESKTOP: Platform = {
  ...WSL,
  env: "desktop",
  caps: { ...WSL.caps, gui: true, winget: false, flatpak: true },
};

describe("the dedicated WSL tuning setup page", () => {
  test("appears only on machines that have a Windows/WSL boundary", () => {
    const ids = (platform: Platform) => questions(platform, [], [], []).map((step) => step.id);

    expect(ids(WSL)).toContain("wsl-tuning");
    expect(ids(WINDOWS)).toContain("wsl-tuning");
    expect(ids(DESKTOP)).not.toContain("wsl-tuning");
  });

  test("shows the machine-derived host, workload, Rust and disk budgets", () => {
    const tuning = wslTuningChoices({
      windowsMemoryBytes: 32 * GIB,
      windowsLogicalCpus: 12,
      workloadMemoryBytes: 20 * GIB,
      workloadLogicalCpus: 10,
      hostDiskTotalKiB: 900 * 1024 ** 2,
    });
    const page = questions(WSL, [], [], [], [], tuning)
      .find((step) => step.id === "wsl-tuning")!;
    const rows = page.choices.map((choice) => `${choice.label}: ${choice.note}`);

    expect(rows).toContain(
      "Windows headroom: 19.2/32 GiB RAM · 10/12 CPUs · 4 GiB swap",
    );
    expect(rows).toContain(
      "Workload wall: 16G RAM / 800% CPU; Zellij and redskilled stay protected",
    );
    expect(rows).toContain("Per launch: pane 3G, agent 5G, build 8G; hard walls avoid reclaim stalls");
    expect(rows).toContain("Rust: Cargo 5 jobs, libtest 2 threads, nextest 5 threads");
    expect(rows).toContain(
      "Windows disk: admit at 30 GiB free, freeze at 20 GiB, resume at 30 GiB",
    );
  });

  test("is wired into the setup flow used by install", async () => {
    const { steps } = await buildSetupSteps(WSL, {
      windowsMemoryBytes: 32 * GIB,
      windowsLogicalCpus: 12,
      workloadMemoryBytes: 18 * GIB,
      workloadLogicalCpus: 10,
      hostDiskTotalKiB: 900 * 1024 ** 2,
    });
    const page = steps.find((step) => step.id === "wsl-tuning")!;

    expect(page.choices.map((choice) => choice.label)).toEqual([
      "Windows headroom",
      "Workload wall",
      "Per launch",
      "Rust",
      "Windows disk",
      "Activation · wsl --shutdown",
    ]);
    expect(page.choices.find((choice) => choice.label === "Rust")?.note)
      .toBe("Cargo 4 jobs, libtest 2 threads, nextest 4 threads");
  });

  test("observes defaults when install does not inject fixture facts", async () => {
    const { steps } = await buildSetupSteps(WSL);
    const page = steps.find((step) => step.id === "wsl-tuning")!;

    expect(page.choices).toHaveLength(6);
    expect(page.choices.every((choice) => choice.selectable === false)).toBe(true);
  });

  test("labels safe formulas instead of presenting fallback estimates as measurements", () => {
    const rows = wslTuningChoices({
      windowsMemoryBytes: 30 * GIB,
      windowsLogicalCpus: 12,
      workloadMemoryBytes: 18 * GIB,
      workloadLogicalCpus: 10,
      hostDiskTotalKiB: 0,
      hostMeasured: false,
      hostDiskMeasured: false,
    }).map((choice) => `${choice.label}: ${choice.note}`);

    expect(rows).toContain(
      "Windows headroom: 60% Windows RAM · leave 2 CPUs · 4 GiB swap",
    );
    expect(rows).toContain(
      "Windows disk: build reserve max(30 GiB, 3% of C:); freeze max(20 GiB, 2%); resume max(30 GiB, 3%)",
    );
    expect(rows.join("\n")).not.toContain("/30 GiB RAM");
  });

  test("renders the policy as read-only inventory and names the restart boundary", () => {
    const tuning = wslTuningChoices({
      windowsMemoryBytes: 32 * GIB,
      windowsLogicalCpus: 12,
      workloadMemoryBytes: 18 * GIB,
      workloadLogicalCpus: 10,
      hostDiskTotalKiB: 900 * 1024 ** 2,
    });
    const steps = questions(WSL, [], [], [], [], tuning);
    const index = steps.findIndex((step) => step.id === "wsl-tuning");
    const model = {
      steps,
      stepIndex: () => index,
      cursor: () => 0,
      selection: () => [],
      pickedFor: () => [],
      wizard: { isCompleted: () => false },
    } as unknown as SetupModel;
    const frame = renderToString(SetupLayout(model, WSL, 110, 34), 110, 34)
      .replace(/\x1b\[[0-9;]*m/g, "");
    const text = frame.replace(/\s+/g, " ");

    expect(text).toContain("WSL tuning");
    expect(text).toContain("• Windows headroom");
    expect(text).not.toContain("[ ] Windows headroom");
    expect(text).toContain("10/12 CPUs · 4 GiB swap");
    expect(text).toContain("hard walls avoid reclaim stalls");
    expect(text).toContain("nextest 4 threads");
    expect(text).toContain("resume at 30 GiB");
    expect(text).toContain("wsl --shutdown");
    expect(text).toContain("never stops a live distro");
  });
});
