/**
 * A VS Code extension published as a release asset — toon's.
 */

import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { installVsixFromRelease, vsixTag } from "./vscode-extension.ts";

const CAPS = { apt: true, gui: true, systemd: true, winget: false, flatpak: false };
const DESKTOP: Platform = {
  os: "linux", distro: "ubuntu", version: "24.04", codename: "noble",
  env: "desktop", arch: "x64", caps: CAPS,
};
const WSL: Platform = { ...DESKTOP, env: "wsl", caps: { ...CAPS, gui: false } };

function harness(over: Record<string, unknown> = {}) {
  const installed: string[] = [];
  let fetched = 0;
  return {
    installed,
    fetched: () => fetched,
    opts: {
      platform: DESKTOP,
      repo: "reddb-io/toon",
      asset: "reddb-toon.vsix",
      editors: ["code"],
      noDisplay: (p: Platform) =>
        p.env === "wsl" ? "the editor belongs to the Windows half" : "no display",
      fetch: async () => {
        fetched++;
        return "/tmp/reddb-toon.vsix";
      },
      resolve: (cli: string) => `/usr/bin/${cli}`,
      install: async (cliPath: string) => {
        installed.push(cliPath);
        return 0;
      },
      ...over,
    },
  };
}

describe("installing a release .vsix", () => {
  test("into every reachable editor, once fetched and verified", async () => {
    const h = harness({ editors: ["code", "cursor"] });
    const r = await installVsixFromRelease(h.opts);
    expect(r.outcome).toBe("installed");
    expect(h.installed).toEqual(["/usr/bin/code", "/usr/bin/cursor"]);
    expect(h.fetched()).toBe(1);
  });

  test("a half with no display of its own defers, and fetches nothing", async () => {
    // WSL: the editor PATH resolves is the host's, and a Linux path
    // handed to a Windows `code` installs nothing — the failure the
    // red-skills companion was caught in.
    const h = harness({ platform: WSL });
    const r = await installVsixFromRelease(h.opts);
    expect(r.outcome).toBe("deferred");
    if (r.outcome !== "deferred") return;
    expect(r.reason).toContain("Windows half");
    expect(h.fetched()).toBe(0);
  });

  test("a display but no editor defers, and never reaches a package manager", async () => {
    const h = harness({ editors: [] });
    const r = await installVsixFromRelease(h.opts);
    expect(r.outcome).toBe("deferred");
    // The whole difference from the red-skills companion: it may install
    // an editor, this never does. So nothing is fetched either.
    expect(h.fetched()).toBe(0);
  });

  test("a download that could not happen is unreachable, not failed", async () => {
    const h = harness({
      fetch: async () => {
        throw new Error("network down");
      },
    });
    const r = await installVsixFromRelease(h.opts);
    expect(r.outcome).toBe("unreachable");
  });

  test("an editor that refuses the extension is a failure", async () => {
    const h = harness({ install: async () => 1 });
    const r = await installVsixFromRelease(h.opts);
    expect(r.outcome).toBe("failed");
  });

  test("one editor refusing while another takes it still installs", async () => {
    const seen: string[] = [];
    const h = harness({
      editors: ["code", "cursor"],
      install: async (cliPath: string) => {
        seen.push(cliPath);
        return cliPath.endsWith("cursor") ? 1 : 0;
      },
    });
    const r = await installVsixFromRelease(h.opts);
    expect(r.outcome).toBe("installed");
    if (r.outcome !== "installed") return;
    expect(r.editors).toEqual(["code"]);
  });
});

describe("the version an asset carries", () => {
  test("read when present, null when the name has none", () => {
    expect(vsixTag("reddb-toon-0.29.6.vsix")).toBe("0.29.6");
    // toon's actual asset is unversioned; the release tag is the version.
    expect(vsixTag("reddb-toon.vsix")).toBeNull();
  });
});
