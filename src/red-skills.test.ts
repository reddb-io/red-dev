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
import { AGENTS, SKILL_HOSTS } from "./agents.ts";
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

  test("asks each host separately", () => {
    // The first version asked Claude and let it answer for everything.
    // Install Codex a week after Claude and the check says "wired",
    // skips, and Codex never gets a marketplace — which is the case
    // that prompted this and the reason the probe is a table.
    expect(SKILL_HOSTS.map((h) => h.cmd).sort()).toEqual(["claude", "codex", "opencode"]);
  });

  test("every host is a real agent, so the two lists cannot drift", () => {
    const keys = new Set(AGENTS.map((a) => a.key));
    for (const h of SKILL_HOSTS) expect(keys.has(h.agent)).toBe(true);
  });

  test("asks the CLI where the CLI can answer", () => {
    // ~/.red-skills exists the moment the installer has ever run, and
    // it existed here for two days with nothing wired anywhere. What
    // the user sees is the marketplace list, so that is what is asked.
    expect(src).toContain('"marketplace", "list"');
  });

  test("and reads the manifest where it cannot", () => {
    // OpenCode has no marketplace to list. The installer records what
    // it generated in an uninstall manifest; the config directory
    // existing means nothing, since opencode creates that itself.
    expect(src).toContain("redskills-install-manifest.txt");
  });

  test("treats an unanswerable question as done rather than as broken", () => {
    // Otherwise a machine whose claude is broken for unrelated reasons
    // reinstalls red-skills on every single converge.
    const fn = src.slice(src.indexOf("async function cliNamesRedSkills"));
    expect(fn.slice(0, fn.indexOf("\n}"))).toContain("return true");
  });

  test("says so out loud when there is no agent to configure", () => {
    expect(src).toContain("no coding agent installed to configure");
  });

  test("names the hosts it is about to wire", () => {
    // A converge that reinstalls should say which host was missing,
    // rather than reporting work with no reason attached.
    expect(src).toContain("not wired into");
  });
});
