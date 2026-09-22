/**
 * The input side of dit, decided without a machine.
 */

import { describe, expect, test } from "bun:test";

import { ditInputPlan, needsSudo, UINPUT_RULE, type DitInputFacts } from "./dit.ts";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";

const DESKTOP = {
  os: "linux", distro: "ubuntu", version: "24.04", codename: "noble", env: "desktop", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
} as Platform;

const done: DitInputFacts = {
  inInputGroup: true,
  ruleText: `${UINPUT_RULE}\n`,
  gnome: true,
  extensionInstalled: true,
};

describe("ditInputPlan", () => {
  test("a converged machine has nothing to do", () => {
    expect(ditInputPlan(done)).toEqual([]);
  });

  test("a fresh desktop needs all three", () => {
    expect(ditInputPlan({ inInputGroup: false, ruleText: null, gnome: true, extensionInstalled: false }))
      .toEqual(["group", "udev", "extension"]);
  });

  test("a rule without static_node is a rule to rewrite", () => {
    // /dev/uinput does not exist until the module loads; static_node is
    // what makes it exist at boot, and a hand-written rule usually
    // lacks it — the "works after the second reboot" report.
    const plan = ditInputPlan({ ...done, ruleText: 'KERNEL=="uinput", GROUP="input", MODE="0660"\n' });
    expect(plan).toEqual(["udev"]);
  });

  test("the focus bridge is only owed on GNOME", () => {
    expect(ditInputPlan({ ...done, gnome: false, extensionInstalled: false })).toEqual([]);
  });

  test("sudo is asked for only when root work is on the plan", () => {
    expect(needsSudo(["extension"])).toBe(false);
    expect(needsSudo(["udev"])).toBe(true);
    expect(needsSudo(["group", "extension"])).toBe(true);
  });
});

describe("dit in the manifest", () => {
  test("the binary comes from mise on Linux, so update and prune reach it", () => {
    const dit = TOOLS.find((t) => t.name === "dit")!;
    const pr = providerFor(dit, DESKTOP);
    expect(pr.kind).toBe("mise");
    if (pr.kind === "mise") expect(pr.spec).toBe("github:reddb-io/dit");
  });

  test("the input side is its own managed row, after the binary", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.indexOf("dit-input")).toBeGreaterThan(names.indexOf("dit"));
    const row = TOOLS.find((t) => t.name === "dit-input")!;
    expect(row.managed).toBe(true);
    expect(providerFor(row, DESKTOP)).toMatchObject({ kind: "builtin", name: "dit-input", needsSudo: true });
  });

  test("autostart is one managed row after input setup", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.indexOf("dit-autostart")).toBe(names.indexOf("dit-input") + 1);
    const row = TOOLS.find((t) => t.name === "dit-autostart")!;
    expect(row.managed).toBe(true);
    expect(providerFor(row, DESKTOP)).toEqual({ kind: "builtin", name: "dit-autostart" });
  });

  test("its one shared library is declared, by the name Ubuntu 24.04 ships", () => {
    const alsa = TOOLS.find((t) => t.name === "libasound2")!;
    expect(providerFor(alsa, DESKTOP)).toMatchObject({ kind: "apt", pkg: "libasound2t64" });
  });
});
