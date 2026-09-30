import { describe, expect, test } from "bun:test";
import { distroArgv, distroSetupCommands, planFor, selectDistro, syncSelectedTooling, syncWslDistro, relayWslCommand, wslChildEnvironment, type WslSyncSeams } from "./wsl-sync.ts";
import type { Platform } from "./platform.ts";
const WINDOWS: Platform = { os: "windows", env: "windows", distro: null, version: null, codename: null, arch: "x64", caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false } };
import type { WslState } from "./wsl-provision.ts";
const state: WslState = { available: true, distros: ["docker-desktop", "Ubuntu-24.04", "Ubuntu-26.04"], detail: "installed", distributions: [ { name: "docker-desktop", version: 2, default: true }, { name: "Ubuntu-24.04", version: 2, default: false }, { name: "Ubuntu-26.04", version: 2, default: false } ] };
const p = () => ({ ...WINDOWS, workstation: "windows-wsl" as const });
function seams(calls: string[], run: NonNullable<WslSyncSeams["run"]> = async (_distro, cmd) => { calls.push(cmd); return 0; }): WslSyncSeams {
  return { state: async () => state, install: async () => { throw Error("unexpected WSL install"); }, user: async () => true, ensure: async name => { calls.push(`ensure ${name}`); return 0; }, preferences: async () => ({ terminalShell: "wsl", agents: ["redcode", "codex"], runtimes: ["rust@latest"] }), record: async (_p, prefs) => { calls.push(`record ${prefs.distro}`); }, prepare: async () => { calls.push("preserve data"); }, migrate: async () => { calls.push("retire native services"); }, run };
}
describe("Windows coordinator", () => {
  test("selects Ubuntu over Docker and obeys a pinned distro without silently switching", () => {
    expect(selectDistro(state)?.name).toBe("Ubuntu-24.04");
    expect(selectDistro(state, "Ubuntu-26.04")?.name).toBe("Ubuntu-26.04");
    expect(selectDistro(state, "missing")).toBeNull();
  });
  test("bootstraps fresh installations and upgrades only a stale red-dev", () => {
    expect(planFor(null, "1.2.3").how).toBe("bootstrap");
    expect(planFor("1.2.2", "1.2.3").how).toBe("upgrade");
    expect(planFor("1.2.3", "1.2.3").install).toBe(false);
  });
  test("configures Linux before decommissioning the native services", async () => {
    const calls: string[] = [];
    await syncWslDistro(p(), seams(calls));
    expect(calls).toEqual(["record Ubuntu-24.04", "ensure Ubuntu-24.04", "preserve data", "red-dev install --yes", "red-dev lang rust@latest", "red-dev agents redcode,codex", "systemctl --user is-active redskilled.service red-router.service", "retire native services"]);
  });
  test("carries a child installation failure into the host result and preserves the native services", async () => {
    const calls: string[] = [];
    const s = seams(calls, async (_d, cmd) => { calls.push(cmd); return cmd.startsWith("red-dev install") ? 2 : 0; });
    await expect(syncWslDistro(p(), s)).rejects.toThrow("Linux installation incomplete");
    expect(calls).not.toContain("retire native services");
  });
  test("does not retire the native services when Linux services are not active", async () => {
    const calls: string[] = [];
    await expect(syncWslDistro(p(), seams(calls, async (_d, cmd) => cmd.startsWith("systemctl") ? 1 : 0))).rejects.toThrow("not active");
    expect(calls).not.toContain("retire native services");
  });
  test("refuses root provisioning and does not mutate a Linux-only machine", async () => {
    const calls: string[] = []; const s = seams(calls); s.user = async () => false;
    await expect(syncWslDistro(p(), s)).rejects.toThrow("as root");
    await syncWslDistro({ ...p(), os: "linux", env: "desktop" }, s);
    expect(calls).toEqual([]);
  });
  test("coordinates updates and validates the selected tooling before migration", async () => {
    const calls: string[] = []; const s = seams(calls); s.action = "update";
    await syncWslDistro(p(), s); expect(calls).toContain("red-dev update --yes");
    expect(calls.indexOf("retire native services")).toBeGreaterThan(calls.indexOf("red-dev update --yes"));
    expect(await syncSelectedTooling(p(), undefined, seams([], async () => 1))).toBe(2);
  });
  test("read-only relay never bootstraps, repairs or selects another distro", async () => {
    const calls: string[] = []; const s = seams(calls);
    expect(await relayWslCommand({ ...p(), wslDistro: "Ubuntu-26.04" }, "red-dev doctor", s)).toBe(0);
    expect(calls).toEqual(["red-dev doctor"]);
    expect(await relayWslCommand({ ...p(), wslDistro: "missing" }, "red-dev plan", s)).toBe(1);
    expect(calls).toEqual(["red-dev doctor"]);
  });
  test("forwards credentials in the child environment while argv contains only public commands", () => {
    const token = "fixture-secret";
    const env = wslChildEnvironment({ WSLENV: "CUSTOM/p" }, token);
    expect(env.WSLENV).toBe("CUSTOM/p:GH_TOKEN:GITHUB_TOKEN"); expect(env.GH_TOKEN).toBe(token);
    const argv = distroArgv("Ubuntu-24.04", "red-dev install --yes");
    expect(argv.join(" ")).not.toContain(token); expect(argv.at(-1)).toContain("RED_DEV_WSL_CHILD");
    expect(distroSetupCommands("wsl", ["codex", "injection; echo broken"], ["rust@latest", "unknown"])).toEqual(["red-dev lang rust@latest", "red-dev agents codex"]);
  });
});
