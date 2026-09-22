import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { desktopCommand, type DesktopDeps, type DesktopCheck } from "./desktop.ts";
import type { Platform } from "./platform.ts";

const desktop: Platform = {
  os: "linux", distro: "ubuntu", version: "24.04", codename: "noble", env: "desktop", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};
function fake(checks: DesktopCheck[] = []) {
  const calls: string[] = [];
  const deps: DesktopDeps = {
    declareMise: () => { calls.push("declare"); },
    bar: async () => { calls.push("bar"); },
    keys: async () => { calls.push("keys"); },
    inspect: async () => { calls.push("inspect"); return checks; },
  };
  return { deps, calls };
}

describe("desktop command", () => {
  test("the real CLI dispatches desktop status without mutating the host", async () => {
    // WSL is intentionally not a GNOME target. This proves actual dispatch,
    // not just parsing, without asking the test runner's desktop to change.
    const proc = Bun.spawn([process.execPath, "src/main.ts", "desktop", "status"], {
      env: { ...process.env, WSL_DISTRO_NAME: "red-dev-desktop-test" },
      stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(output).toContain("desktop: GNOME menu reconciliation applies only to the Linux desktop");
    expect(output).not.toContain("unhandled command");
  });

  test("status only inspects, and exposes drift as exit 2", async () => {
    const { deps, calls } = fake([{ name: "menu", status: "drift", detail: "missing" }]);
    expect(await desktopCommand(desktop, "status", deps)).toBe(2);
    expect(calls).toEqual(["inspect"]);
  });

  test("reconcile applies only declarations, bar and keys, then inspects", async () => {
    const { deps, calls } = fake([{ name: "menu", status: "ok", detail: "current runtime" }]);
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(0);
    expect(calls).toEqual(["declare", "bar", "keys", "inspect"]);
  });

  test("a failed bar does not suppress shortcut repair or report success", async () => {
    const { deps, calls } = fake();
    deps.bar = async () => { calls.push("bar"); throw new Error("enable refused"); };
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(1);
    expect(calls).toEqual(["declare", "bar", "keys", "inspect"]);
  });

  test("a pending login is deferred, not mistaken for a failed mise install", async () => {
    const { deps } = fake([{ name: "menu", status: "drift", detail: "sign in again", deferred: true }]);
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(0);
    expect(await desktopCommand(desktop, "status", deps)).toBe(2);
  });

  test("a pending login cannot hide real shortcut failures", async () => {
    const { deps } = fake([
      { name: "menu", status: "drift", detail: "sign in again", deferred: true },
      { name: "keys", status: "drift", detail: "missing binding" },
    ]);
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(2);
  });

  test("a headless mise upgrade defers GNOME without falsely reporting a repaired desktop", async () => {
    const { deps, calls } = fake();
    deps.session = async () => "absent";
    deps.postinstall = true;
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(0);
    expect(calls).toEqual(["declare"]);
    deps.postinstall = false;
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(2);
  });

  test("an unavailable session cannot hide a failed config write", async () => {
    const { deps } = fake();
    deps.session = async () => "absent";
    deps.postinstall = true;
    deps.declareMise = () => { throw new Error("read-only config"); };
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(1);
  });

  test("unknown session probes do not downgrade real permission failures to deferred", async () => {
    const { deps, calls } = fake();
    deps.session = async () => "unknown";
    deps.postinstall = true;
    deps.bar = async () => { calls.push("bar"); throw new Error("permission denied"); };
    expect(await desktopCommand(desktop, "reconcile", deps)).toBe(1);
    expect(calls).toEqual(["declare", "bar", "keys", "inspect"]);
  });

  test("all other targets skip without writes or GNOME probes", async () => {
    for (const platform of [
      { ...desktop, env: "server" as const }, { ...desktop, env: "wsl" as const },
      { ...desktop, os: "windows" as const, env: "windows" as const },
    ]) {
      const { deps, calls } = fake();
      expect(await desktopCommand(platform, "reconcile", deps)).toBe(0);
      expect(calls).toEqual([]);
    }
  });

  test("the default path cannot invoke package install, sudo or service restarts", () => {
    const source = readFileSync(new URL("./desktop.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/Bun\.(spawn|\$)|applyProvider|cmdInstall|runMise|systemctl|sudo/);
    expect(source).toContain("convergeMiseConfig(p)");
  });
});
