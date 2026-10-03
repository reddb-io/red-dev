import { describe, expect, test } from "bun:test";
import { applyWorkstationPreferences, runsHere } from "./workstation.ts";
import { TOOLS, providerFor } from "./manifest.ts";
import { AGENTS, agentRunsHere } from "./agents.ts";
import { miseEntries } from "./mise-config.ts";
import { setupPlan } from "./firstrun.ts";
import type { Platform } from "./platform.ts";

export const WINDOWS: Platform = { os: "windows", env: "windows", distro: null, version: null, codename: null, arch: "x64", caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false } };
const WSL: Platform = { ...WINDOWS, os: "linux", env: "wsl", distro: "ubuntu", version: "24.04", caps: { ...WINDOWS.caps, apt: true, gui: false, systemd: true } };
const owned = (name: string, p: Platform) => providerFor(TOOLS.find(t => t.name === name)!, { ...p, profile: { schema: 1, name: "ubuntu-desktop", tools: { "red-router": true } } }).kind;
describe("workstation placement", () => {
  test("defaults Windows to WSL and preserves an explicit native choice", () => {
    expect(applyWorkstationPreferences({ ...WINDOWS }, {}).workstation).toBe("windows-wsl");
    expect(applyWorkstationPreferences({ ...WINDOWS }, { terminalShell: "gitbash" }).workstation).toBe("windows-native");
    expect(applyWorkstationPreferences({ ...WINDOWS }, { terminalShell: "wsl", distro: "Ubuntu-26.04" }).wslDistro).toBe("Ubuntu-26.04");
  });
  test("every production tool and agent declares a destination", () => {
    expect(TOOLS.every(t => ["host", "linux", "both"].includes(t.placement!))).toBe(true);
    expect(AGENTS.every(a => ["host", "linux", "both"].includes(a.placement!))).toBe(true);
  });
  test("places desktop apps on Windows and services/shell on Linux", () => {
    const host = applyWorkstationPreferences({ ...WINDOWS }, {});
    for (const name of ["alacritty", "codex-desktop", "claude-desktop", "antigravity", "vscode"]) expect(owned(name, host)).toBe(owned(name, { ...WINDOWS, workstation: "windows-native" }));
    expect(owned("alacritty", host)).toBe("winget");
    for (const name of ["red-router", "red-router-autostart", "zellij", "bash-completion", "dotfiles"]) {
      expect(owned(name, host)).toBe("skip"); expect(owned(name, WSL)).not.toBe("skip");
    }
    expect(owned("alacritty-config", WSL)).toBe("skip");
    expect(owned("red-dev", host)).toBe("mise"); expect(owned("red-dev", WSL)).toBe("mise");
  });
  test("native Ubuntu owns both graphical applications and Linux tooling", () => {
    const ubuntu = { ...WSL, env: "desktop" as const, caps: { ...WSL.caps, gui: true } };
    expect(runsHere("host", ubuntu)).toBe(true); expect(runsHere("linux", ubuntu)).toBe(true);
    expect(owned("alacritty", ubuntu)).toBe("apt"); expect(owned("red-router", ubuntu)).toBe("mise");
  });
  test("keeps redcode in both environments and delegates other CLI agents", () => {
    const host = applyWorkstationPreferences({ ...WINDOWS }, {});
    expect(agentRunsHere(AGENTS.find(a => a.key === "redcode")!, host)).toBe(true);
    expect(agentRunsHere(AGENTS.find(a => a.key === "codex")!, host)).toBe(false);
    const aliases = miseEntries(host).map(e => e.alias);
    expect(aliases).toContain("red-dev"); expect(aliases).toContain("redcode"); expect(aliases).not.toContain("red-router");
  });
  test("Windows setup never installs the selected build runtimes or Linux agents locally", async () => {
    const host = applyWorkstationPreferences({ ...WINDOWS }, {});
    const plan = await setupPlan(host, { agents: ["codex", "redcode"], runtimes: ["rust", "go"], apps: [] }, async () => true);
    expect(plan.filter(s => s.kind === "runtime")).toEqual([]);
    expect(plan.filter(s => s.kind === "agent").map(s => s.key)).toEqual(["redcode"]);
  });
});
