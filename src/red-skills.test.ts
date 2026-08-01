/**
 * red-skills was not part of a converge, so it was not installed.
 *
 * It ran in exactly two places: the first-run interview, and behind a
 * confirm inside `red-dev agents`. A plain `install core` — which is
 * what the install script runs, and what anyone re-running red-dev
 * gets — never touched it. This machine carried claude, codex, opencode
 * and herdr with no marketplace registered in any of them.
 *
 * The readiness check is the other half. `~/.red-skills` had existed for
 * two days: the installer had run, the source cache was there, and
 * nothing was wired. Testing for the directory would have reported
 * success on exactly the broken state that prompted this.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TOOLS, applicableScopes, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";

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

const tool = TOOLS.find((t) => t.name === "red-skills");

describe("red-skills as a converge step", () => {
  test("is in the manifest", () => {
    expect(tool).toBeDefined();
  });

  test("is in core, so the install script runs it", () => {
    // Not optional and not desktop: the point is that installing
    // red-dev at all is enough, on every target that can host an agent.
    expect(tool!.scope).toBe("core");
  });

  test("runs on every target, because agents run on every target", () => {
    for (const p of [
      platform({}),
      platform({ env: "wsl", caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false } }),
      platform({ os: "windows", env: "windows", caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false } }),
      platform({ env: "server", caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } }),
    ]) {
      expect(applicableScopes(p)).toContain(tool!.scope);
      expect(providerFor(tool!, p)).toEqual({ kind: "builtin", name: "red-skills" });
    }
  });

  test("comes after the agents it configures", () => {
    // The installer detects which CLIs exist and wires each one. Run
    // before them it configures nothing and reports success, which is
    // the failure mode this whole file exists about.
    const names = TOOLS.map((t) => t.name);
    const agents = names.indexOf("agents");
    if (agents !== -1) expect(names.indexOf("red-skills")).toBeGreaterThan(agents);
  });
});

describe("how it decides it is already done", () => {
  const src = readFileSync("src/agents.ts", "utf8");

  /** The readiness function alone, not the file that documents it. */
  const wired = (() => {
    const from = src.indexOf("export async function redSkillsWired");
    return src.slice(from, src.indexOf("\n}", from));
  })();

  test("asks the CLI, not the filesystem", () => {
    // ~/.red-skills exists the moment the installer has ever run, and
    // it existed here for two days with nothing wired anywhere. The
    // check has to reach the thing the user actually sees.
    expect(wired).toContain("marketplace");
    expect(wired).toContain("list");
    expect(wired).not.toContain("existsSync");
    expect(wired).not.toContain("HOME");
  });

  test("treats an unanswerable question as done rather than as broken", () => {
    // Otherwise a machine where the probe cannot run reinstalls
    // red-skills on every single converge.
    const fn = src.slice(src.indexOf("export async function redSkillsWired"));
    expect(fn.slice(0, fn.indexOf("}\n\n"))).toContain("return true");
  });

  test("says so out loud when there is no agent to configure", () => {
    expect(src).toContain("no coding agent installed to configure");
  });
});
