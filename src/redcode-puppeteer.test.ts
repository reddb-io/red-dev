import { describe, expect, test } from "bun:test";
import {
  AGENTS,
  agentInstallMethod,
  availableAgents,
  currentAgentKeys,
} from "./agents.ts";
import { setupPlan } from "./firstrun.ts";
import { providerFor, TOOLS } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { exactGhReleaseUrl } from "./providers.ts";
import { puppeteerCli } from "./puppeteer.ts";

function platform(os: "linux" | "windows", arch: Platform["arch"] = "x64"): Platform {
  return {
    os,
    distro: os === "linux" ? "ubuntu" : undefined,
    version: os === "linux" ? "24.04" : "11",
    codename: os === "linux" ? "noble" : undefined,
    env: os === "linux" ? "desktop" : "windows",
    arch,
    caps: {
      apt: os === "linux",
      gui: true,
      systemd: os === "linux",
      winget: os === "windows",
      flatpak: os === "linux",
    },
  } as Platform;
}

describe("RedCode", () => {
  const redcode = AGENTS.find((agent) => agent.key === "redcode")!;

  test("replaces OpenCode in the selectable catalog", () => {
    expect(redcode.cmd).toBe("redcode");
    expect(AGENTS.some((agent) => agent.key === "opencode")).toBe(false);
  });

  test("uses exact public release archives without a GitHub API lookup", () => {
    expect(agentInstallMethod(redcode, platform("linux"))).toBe("github-release");
    expect(redcode.release?.linux.x64).toBe("redcode-linux-x64.tar.gz");
    expect(redcode.release?.windows.x64).toBe("redcode-windows-x64.zip");
    expect(exactGhReleaseUrl("reddb-io/redcode", "redcode-linux-x64.tar.gz")).toBe(
      "https://github.com/reddb-io/redcode/releases/latest/download/redcode-linux-x64.tar.gz",
    );
    expect(exactGhReleaseUrl("reddb-io/redcode", "SHA256SUMS")).toEndWith(
      "/releases/latest/download/SHA256SUMS",
    );
  });

  test("offers only architectures for which the release exists", () => {
    expect(availableAgents(platform("linux", "x64"))).toContain(redcode);
    expect(availableAgents(platform("windows", "arm64"))).toContain(redcode);
    expect(availableAgents(platform("linux", "unsupported"))).not.toContain(redcode);
  });

  test("migrates old selections side-by-side and deduplicates", () => {
    expect(currentAgentKeys(["opencode", "codex", "redcode"])).toEqual(["redcode", "codex"]);
  });
});

describe("Puppeteer toolchain", () => {
  const tool = TOOLS.find((candidate) => candidate.name === "puppeteer")!;

  test("is an optional managed tool with Linux-only sudo requirements", () => {
    expect(tool.scope).toBe("optional");
    expect(tool.managed).toBe(true);
    expect(providerFor(tool, platform("linux"))).toEqual({
      kind: "builtin",
      name: "puppeteer",
      needsSudo: true,
    });
    expect(providerFor(tool, platform("linux")).needsSudo).toBe(true);
    expect(providerFor(tool, platform("windows")).needsSudo).toBeUndefined();
  });

  test("brings Node when selected without a runtime", async () => {
    const plan = await setupPlan(platform("linux"), {
      agents: [],
      runtimes: [],
      apps: ["puppeteer"],
    });
    expect(plan[0]).toMatchObject({ key: "node@24", kind: "runtime" });
  });

  test("resolves the npm global CLI on either platform", () => {
    expect(puppeteerCli("/opt/node", platform("linux"))).toBe("/opt/node/bin/puppeteer");
    expect(puppeteerCli("C:/mise/node", platform("windows"))).toBe(
      "C:/mise/node/puppeteer.cmd",
    );
  });
});
