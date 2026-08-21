/**
 * red-dev taking a red-dev, and the two ways that quietly did nothing.
 */

import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { compareVersions, redDevAsset, updateRedDev } from "./self-update.ts";

const CAPS = { apt: true, gui: false, systemd: true, winget: false, flatpak: false };
const WSL: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: CAPS,
};
const WIN: Platform = { ...WSL, os: "windows", env: "windows", distro: null, codename: null };

function harness(over: Record<string, unknown> = {}) {
  const ran: string[][] = [];
  return {
    ran,
    opts: {
      current: "1.0.99",
      platform: WSL,
      latest: async () => "v1.0.100",
      owned: async () => true,
      installed: async () => "1.0.100",
      run: async (argv: string[]) => {
        ran.push(argv);
        return 0;
      },
      ...over,
    },
  };
}

describe("which version is newer", () => {
  test("a three-digit patch is not compared as text", () => {
    // The day this file was written the machine crossed 1.0.99 -> 1.0.100,
    // where every lexicographic comparison says the wrong thing.
    expect(compareVersions("1.0.100", "1.0.99")).toBeGreaterThan(0);
    expect(compareVersions("1.0.99", "1.0.100")).toBeLessThan(0);
    expect(compareVersions("1.0.100", "1.0.100")).toBe(0);
  });

  test("a leading v is not part of the number", () => {
    expect(compareVersions("v1.0.100", "1.0.100")).toBe(0);
  });

  test("a shorter version is not newer for being shorter", () => {
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    expect(compareVersions("2.0", "1.9.9")).toBeGreaterThan(0);
  });
});

describe("which asset this machine would take", () => {
  test("one per published target, and nothing invented", () => {
    expect(redDevAsset(WSL)).toBe("red-dev-linux-x64");
    expect(redDevAsset(WIN)).toBe("red-dev-windows-x64.exe");
    // A release carries no arm64 binary; a machine must not be told one
    // is waiting for it.
    expect(redDevAsset({ ...WSL, arch: "arm64" })).toBeNull();
  });
});

describe("taking it", () => {
  test("a newer release is taken, and the cache is cleared first", async () => {
    const h = harness();
    const result = await updateRedDev(h.opts);

    expect(result.outcome).toBe("took");
    expect(result.reason).toBe("1.0.99 -> 1.0.100");
    // The whole reason this file asks the publisher instead of mise:
    // `mise upgrade` answered "All tools are up to date" against a list
    // cached before the release existed.
    expect(h.ran.map((a) => a.join(" "))).toEqual([
      "mise cache clear red-dev",
      "mise upgrade red-dev",
    ]);
  });

  test("nothing newer runs nothing at all", async () => {
    const h = harness({ latest: async () => "v1.0.99" });
    const result = await updateRedDev(h.opts);
    expect(result.outcome).toBe("current");
    expect(h.ran).toEqual([]);
  });

  test("an older tag is not taken, so a bad redirect cannot roll a machine back", async () => {
    const h = harness({ latest: async () => "v1.0.50" });
    expect((await updateRedDev(h.opts)).outcome).toBe("current");
    expect(h.ran).toEqual([]);
  });

  test("a publisher that cannot be asked is not a failure", async () => {
    const h = harness({ latest: async () => null });
    const result = await updateRedDev(h.opts);
    expect(result.outcome).toBe("unreachable");
    expect(h.ran).toEqual([]);
  });

  test("a machine mise does not hold red-dev on is told, not moved", async () => {
    // boot.ps1 and boot.sh place a copy mise knows nothing about.
    const h = harness({ owned: async () => false });
    const result = await updateRedDev(h.opts);
    expect(result.outcome).toBe("unavailable");
    expect(result.reason).toContain("red-dev install core");
    expect(h.ran).toEqual([]);
  });

  test("an upgrade that did not move the version says so", async () => {
    const h = harness({ installed: async () => "1.0.99" });
    const result = await updateRedDev(h.opts);
    expect(result.outcome).toBe("refused");
    expect(result.reason).toContain("still on 1.0.99");
  });

  test("the version decides, not mise's exit code", async () => {
    // mise removes the previous install once the new one is placed, and
    // on Windows that removal fails while the previous one is running.
    // A cleanup that failed is not an upgrade that failed.
    const h = harness({ run: async () => 1 });
    expect((await updateRedDev(h.opts)).outcome).toBe("took");
  });

  test("an architecture with no published binary is not offered one", async () => {
    const h = harness({ platform: { ...WSL, arch: "arm64" } });
    const result = await updateRedDev(h.opts);
    expect(result.outcome).toBe("unavailable");
    expect(h.ran).toEqual([]);
  });
});
