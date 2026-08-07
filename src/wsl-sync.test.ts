/**
 * A WSL machine is two machines, and only one of them was converging.
 *
 * `boot.ps1` installed the Windows target and stopped at the boundary.
 * The distro — separate home, separate PATH, separate copy of red-dev —
 * kept whatever it had, and the terminal red-dev configures opens
 * `wsl.exe`, so the half being typed into was the half nobody updated.
 * Observed: Windows on 0.11.0 beside a distro on 0.2.2 with dotfiles
 * three days old, no error anywhere, and a feature that had just been
 * installed simply absent.
 */

import { describe, expect, test } from "bun:test";
import { planFor } from "./wsl-sync.ts";
import { TOOLS, applicableScopes, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";

describe("what the distro needs", () => {
  test("installs when the distro has no red-dev at all", () => {
    const plan = planFor(null, "0.11.1");
    expect(plan.install).toBe(true);
    expect(plan.reason).toContain("no red-dev");
  });

  test("installs when the distro is behind", () => {
    // The case that was actually on the machine.
    const plan = planFor("0.2.2", "0.11.1");
    expect(plan.install).toBe(true);
    expect(plan.reason).toContain("0.2.2");
    expect(plan.reason).toContain("0.11.1");
  });

  test("installs when the distro is somehow ahead", () => {
    // Not a version comparison, a sameness one. Two halves of one
    // machine running different builds is the condition being fixed,
    // and which way round it is does not change that.
    expect(planFor("0.12.0", "0.11.1").install).toBe(true);
  });

  test("does not download 99 MB to arrive where it already is", () => {
    const plan = planFor("0.11.1", "0.11.1");
    expect(plan.install).toBe(false);
    expect(plan.reason).toContain("already");
  });
});

describe("explicit tooling commands", () => {
  test("update a stale distro before executing its selected tools", async () => {
    const source = await Bun.file(new URL("./wsl-sync.ts", import.meta.url)).text();
    const tooling = source.slice(
      source.indexOf("export async function syncSelectedTooling"),
      source.indexOf("/** Run a command inside the distro"),
    );

    expect(tooling).toContain("await ensureDistroRedDev(selected.name)");
    expect(tooling.indexOf("ensureDistroRedDev")).toBeLessThan(
      tooling.indexOf("for (const command of commands)"),
    );
  });
});

/** The platform shapes the manifest branches on. */
function platform(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  } as Platform;
}

describe("where the step runs", () => {
  const tool = TOOLS.find((t) => t.name === "wsl-sync");

  test("is in the manifest", () => {
    expect(tool).toBeDefined();
  });

  test("runs on native Windows", () => {
    // The desktop scope rather than the wsl one, and that is the point:
    // the wsl scope runs *inside* a distro reaching out to Windows, and
    // native Windows never gets it. Putting this there would have been
    // a step that could never fire.
    const win = platform({ os: "windows", env: "windows", caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false } });
    expect(applicableScopes(win)).toContain(tool!.scope);
    expect(providerFor(tool!, win)).toEqual({ kind: "builtin", name: "wsl-sync" });
  });

  test("does not run inside WSL, which has no distro to reach into", () => {
    const wsl = platform({ env: "wsl", caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false } });
    expect(applicableScopes(wsl)).not.toContain(tool!.scope);
  });

  test("is a documented skip on a Linux desktop rather than a builtin", () => {
    // A Linux desktop does get the desktop scope, so the step is
    // reached there and has to answer for itself.
    const linux = platform({});
    expect(applicableScopes(linux)).toContain(tool!.scope);
    expect(providerFor(tool!, linux).kind).toBe("skip");
  });
});
