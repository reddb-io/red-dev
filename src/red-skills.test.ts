/**
 * red-skills was not part of a converge, so it was not installed.
 *
 * It ran in exactly two places: the first-run interview, and behind a
 * confirm inside `red-dev agents`. A plain `install core` — which is
 * what the install script runs, and what anyone re-running red-dev
 * gets — never touched it. This machine carried claude, codex, redcode
 * and herdr with no marketplace registered in any of them.
 *
 * The readiness check is the other half. `~/.red-skills` had existed for
 * two days: the installer had run, the source cache was there, and
 * nothing was wired. Testing for the directory would have reported
 * success on exactly the broken state that prompted this.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOOLS, applicableScopes, providerFor } from "./manifest.ts";
import { AGENTS, SKILL_HOSTS, repairCopiedRedSkillsCurrent } from "./agents.ts";
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
  test("acquires the package set, and downloads no standalone installer", () => {
    // ADR 0010 leaves one acquisition on the machine. red-dev used to
    // curl `scripts/install.sh` from the repo's v3 branch and hand it
    // the whole job — a second owner of `~/.red-skills/current` that
    // registered its own marketplaces and generated its own host
    // surfaces, which is how the hosts and the editor extension came to
    // be on different revisions of the same product.
    const src = readFileSync("src/agents.ts", "utf8");
    expect(src).toContain("acquireRedSkills");
    expect(src).not.toContain("scripts/install.sh");
  });

  test("and nothing anywhere in red-dev reaches for it", () => {
    // Asserted across the whole source tree rather than in agents.ts
    // alone: the criterion is that red-dev no longer downloads or
    // invokes standalone RedSkills acquisition, and a second caller
    // added in another module would satisfy the test above.
    const offenders = [...new Bun.Glob("src/**/*.ts").scanSync(".")]
      .filter((path) => !path.endsWith("red-skills.test.ts"))
      .filter((path) => readFileSync(path, "utf8").includes("red-skills/v3/scripts/install.sh"));
    expect(offenders).toEqual([]);
  });

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

describe("the copied Windows current snapshot", () => {
  test("is removed only when RedSkills' managed markers are present", () => {
    const home = mkdtempSync(`${tmpdir()}/red-skills-current-`);
    const current = `${home}/.red-skills/current`;
    mkdirSync(`${current}/.claude-plugin`, { recursive: true });
    writeFileSync(`${current}/.claude-plugin/marketplace.json`, "{}");
    writeFileSync(`${current}/.upstream`, "red-skills");

    expect(repairCopiedRedSkillsCurrent(home, "win32")).toBe(true);
    expect(existsSync(current)).toBe(false);
  });

  test("an unrelated current directory is never removed", () => {
    const home = mkdtempSync(`${tmpdir()}/red-skills-current-user-`);
    const current = `${home}/.red-skills/current`;
    mkdirSync(current, { recursive: true });
    writeFileSync(`${current}/mine.txt`, "keep");

    expect(repairCopiedRedSkillsCurrent(home, "win32")).toBe(false);
    expect(existsSync(`${current}/mine.txt`)).toBe(true);
  });

  test("is cleared before the package set tries to link over it", () => {
    // The set activates by putting a link at `~/.red-skills/current` and
    // refuses to remove a real directory standing there. The copy is
    // the one such directory red-dev can prove it owns, so clearing it
    // has to happen above the acquisition rather than after it fails.
    const src = readFileSync("src/agents.ts", "utf8");
    const start = src.indexOf("export async function installRedSkills");
    const end = src.indexOf("export async function updateRedSkills", start);
    const body = src.slice(start, end);
    expect(body.indexOf("repairCopiedRedSkillsCurrent")).toBeGreaterThan(-1);
    expect(body.indexOf("repairCopiedRedSkillsCurrent")).toBeLessThan(
      body.indexOf("acquireRedSkills("),
    );
  });
});

describe("how it decides it is already done", () => {
  const src = readFileSync("src/agents.ts", "utf8");

  test("asks each host separately", () => {
    // The first version asked Claude and let it answer for everything.
    // Install Codex a week after Claude and the check says "wired",
    // skips, and Codex never gets a marketplace — which is the case
    // that prompted this and the reason the probe is a table.
    expect(SKILL_HOSTS.map((h) => h.cmd).sort()).toEqual(["claude", "codex", "redcode"]);
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
    // RedCode has no marketplace to list. The installer records what
    // it generated in an uninstall manifest; the config directory
    // existing means nothing, since redcode creates that itself.
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

describe("which registration a converge leaves behind", () => {
  const src = readFileSync("src/agents.ts", "utf8");

  test("the marketplace list cannot tell a directory source from a GitHub one", () => {
    // `red-skills` is in `plugin marketplace list` either way, which is
    // why being wired and being registered the way red-dev declares are
    // two different questions asked in two different places.
    const wired = src.slice(src.indexOf("async function cliNamesRedSkills"));
    expect(wired.slice(0, wired.indexOf("\n}"))).toContain("red-skills");
    expect(src).toContain("convergeMarketplaceOwnership");
  });

  test("red-dev declares its registration after the source exists, never before", () => {
    // The directory red-dev registers is `~/.red-skills/current`, so a
    // converge that declared before acquiring would point both hosts at
    // a path with nothing behind it. The acquisition is now conditional
    // — only a machine with no source at all reaches it — and the
    // declaration still comes after.
    const converge = src.slice(src.indexOf("export async function convergeRedSkills"));
    const acquired = converge.indexOf("await installRedSkills(p)");
    const declared = converge.indexOf("convergeMarketplaceOwnership");
    expect(acquired).toBeGreaterThan(-1);
    expect(declared).toBeGreaterThan(acquired);
  });

  test("and a machine that already resolves a set acquires nothing", () => {
    // The old converge re-ran the installer whenever a host looked
    // unwired, which meant a marketplace registration cost a download.
    // Wiring is the host reconciliation; an absent source is the only
    // thing an acquisition answers.
    const converge = src.slice(src.indexOf("export async function convergeRedSkills"));
    expect(converge).toContain("if (sourceRoot() === null) await installRedSkills(p)");
  });

  test("and nothing here heals a registration back to GitHub", () => {
    // Both ends of the eviction used to live in this file: one converge
    // registering the directory mise advances, the next repointing it at
    // the repo. Where red-dev is present the directory wins, so the
    // repair is gone rather than merely unused.
    expect(src).not.toContain("repointClaudeMarketplace");
    expect(src).not.toContain("repointCodexMarketplace");
    expect(src).not.toContain('"add", "reddb-io/red-skills"');
  });

  test("castle has the repo-local fallback Codex already searches", () => {
    // The legacy Codex MCP command for castle checks this path before
    // giving up. Keep a real launcher here so a clean session in this
    // repository can still reach the RedSkills marketplace checkout.
    const launcher = readFileSync("plugins/dev/hooks/castle-mcp.sh", "utf8");
    expect(launcher).toContain("red-skills/plugins/dev/hooks/castle-mcp.sh");
  });
});
