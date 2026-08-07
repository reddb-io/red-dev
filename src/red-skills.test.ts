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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { TOOLS, applicableScopes, providerFor } from "./manifest.ts";
import {
  AGENTS,
  SKILL_HOSTS,
  claudeMarketplaceIsGithub,
  codexMarketplaceIsGithub,
  repairCopiedRedSkillsCurrent,
} from "./agents.ts";
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

  test("a first-run copy made before release assets arrive gets one retry", () => {
    const src = readFileSync("src/agents.ts", "utf8");
    const start = src.indexOf("export async function installRedSkills");
    const end = src.indexOf("export async function updateRedSkills", start);
    const body = src.slice(start, end);
    expect(body.match(/repairCopiedRedSkillsCurrent/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain("retrying with the release assets now cached");
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

describe("a marketplace that reports updates it cannot receive", () => {
  const src = readFileSync("src/agents.ts", "utf8");

  /** A HOME holding one crafted known_marketplaces.json. */
  function fakeHome(entry: unknown): string {
    const dir = mkdtempSync(`${tmpdir()}/red-mkt-`);
    mkdirSync(`${dir}/.claude/plugins`, { recursive: true });
    if (entry !== undefined) {
      writeFileSync(
        `${dir}/.claude/plugins/known_marketplaces.json`,
        JSON.stringify({ "red-skills": entry }),
      );
    }
    return dir;
  }

  async function sourceIsGithub(entry: unknown): Promise<boolean | null> {
    const saved = process.env["HOME"];
    process.env["HOME"] = fakeHome(entry);
    try {
      return await claudeMarketplaceIsGithub();
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  }

  test("a directory source is drift, however recently it says it updated", async () => {
    // The exact entry off a real machine: autoUpdate on, a timestamp
    // from today, and a version a week behind. Claude re-reads the
    // snapshot, finds it unchanged, and records success.
    expect(
      await sourceIsGithub({
        source: { source: "directory", path: "/home/x/.red-skills/current" },
        lastUpdated: "2026-08-02T12:35:21.550Z",
        autoUpdate: true,
      }),
    ).toBe(false);
  });

  test("a github source is what a working one looks like", async () => {
    expect(
      await sourceIsGithub({ source: { source: "github", repo: "reddb-io/red-skills" } }),
    ).toBe(true);
  });

  test("no entry is no opinion, not a verdict", async () => {
    // Null means leave the machine alone. Repointing a marketplace on a
    // guess is worse than the drift.
    expect(await sourceIsGithub(undefined)).toBeNull();
  });

  /** A HOME holding one crafted Codex config.toml. */
  function fakeCodexHome(sourceType?: string): string {
    const dir = mkdtempSync(`${tmpdir()}/red-codex-mkt-`);
    mkdirSync(`${dir}/.codex`, { recursive: true });
    if (sourceType !== undefined) {
      writeFileSync(
        `${dir}/.codex/config.toml`,
        [
          "[marketplaces.red-skills]",
          'last_updated = "2026-08-02T18:04:00Z"',
          `source_type = "${sourceType}"`,
          sourceType === "git"
            ? 'source = "https://github.com/reddb-io/red-skills.git"'
            : 'source = "/home/x/.red-skills/versions/v3.3.0"',
          "",
        ].join("\n"),
      );
    }
    return dir;
  }

  async function codexSourceIsGithub(sourceType?: string): Promise<boolean | null> {
    const saved = process.env["HOME"];
    process.env["HOME"] = fakeCodexHome(sourceType);
    try {
      return await codexMarketplaceIsGithub();
    } finally {
      if (saved === undefined) delete process.env["HOME"];
      else process.env["HOME"] = saved;
    }
  }

  test("Codex has the same local-marketplace drift as Claude", async () => {
    expect(await codexSourceIsGithub("local")).toBe(false);
  });

  test("Codex git marketplaces can receive RedSkills updates", async () => {
    expect(await codexSourceIsGithub("git")).toBe(true);
  });

  test("no Codex marketplace entry is no opinion", async () => {
    expect(await codexSourceIsGithub(undefined)).toBeNull();
  });

  test("the name alone cannot tell the two apart", () => {
    // Which is why the old check could not see this: `red-skills`
    // appears in `plugin marketplace list` either way.
    const wired = src.slice(src.indexOf("async function cliNamesRedSkills"));
    expect(wired.slice(0, wired.indexOf("\n}"))).toContain("red-skills");
    expect(src).toContain("claudeMarketplaceIsGithub");
    expect(src).toContain("codexMarketplaceIsGithub");
  });

  test("the repair reinstalls the plugins it removed", () => {
    // They came from a marketplace that no longer exists under that
    // name, so re-adding the source is not enough on its own.
    const repair = src.slice(src.indexOf("export async function repointClaudeMarketplace"));
    for (const plugin of ["dev", "memory", "brain"]) {
      expect(repair).toContain(plugin);
    }
  });

  test("the Codex repair refreshes the plugins that provide MCPs", () => {
    const repair = src.slice(src.indexOf("export async function repointCodexMarketplace"));
    expect(repair).toContain("plugin");
    expect(repair).toContain("marketplace");
    for (const plugin of ["dev", "memory", "brain"]) {
      expect(repair).toContain(plugin);
    }
  });

  test("castle has the repo-local fallback Codex already searches", () => {
    // The legacy Codex MCP command for castle checks this path before
    // giving up. Keep a real launcher here so a clean session in this
    // repository can still reach the RedSkills marketplace checkout.
    const launcher = readFileSync("plugins/dev/hooks/castle-mcp.sh", "utf8");
    expect(launcher).toContain("red-skills/plugins/dev/hooks/castle-mcp.sh");
  });
});
