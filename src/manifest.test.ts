import { describe, expect, test } from "bun:test";
import {
  TOOLS,
  applicableScopes,
  describeProvider,
  isInstalled,
  providerFor,
  toolsInScope,
  type Tool,
} from "./manifest.ts";
import type { Capabilities, Platform } from "./platform.ts";

function platform(over: Partial<Platform> = {}): Platform {
  const caps: Capabilities = {
    apt: true,
    gui: false,
    systemd: true,
    winget: false,
    flatpak: false,
    ...(over.caps ?? {}),
  };
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "wsl",
    arch: "x64",
    ...over,
    caps,
  };
}

const WSL24 = platform();
const WSL26 = platform({ version: "26.04", codename: "resolute" });
const DESKTOP = platform({ env: "desktop", caps: { gui: true } as Capabilities });
const WINDOWS = platform({
  os: "windows",
  env: "windows",
  distro: null,
  version: null,
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
});

describe("applicableScopes", () => {
  test("WSL gets core and wsl, never desktop", () => {
    // The distro has no display; GUI packages belong to the host.
    expect(applicableScopes(WSL24)).toEqual(["core", "wsl"]);
  });

  test("bare-metal desktop gets core and desktop, never wsl", () => {
    expect(applicableScopes(DESKTOP)).toEqual(["core", "desktop"]);
  });

  test("native Windows gets core and desktop", () => {
    // Windows plainly has a display. Treating gui as desktop-Linux-only
    // silently made every winget GUI package unreachable.
    expect(applicableScopes(WINDOWS)).toEqual(["core", "desktop"]);
  });

  test("a headless server gets core only", () => {
    const server = platform({ env: "server" });
    expect(applicableScopes(server)).toEqual(["core"]);
  });
});

describe("providerFor", () => {
  const tool: Tool = {
    name: "example",
    scope: "core",
    u24: { kind: "apt", pkg: "example" },
    u26: { kind: "apt", pkg: "example-ng" },
    win: { kind: "winget", id: "Example.Example" },
  };

  test("picks the column for the running release", () => {
    expect(providerFor(tool, WSL24)).toEqual({ kind: "apt", pkg: "example" });
    expect(providerFor(tool, WSL26)).toEqual({ kind: "apt", pkg: "example-ng" });
    expect(providerFor(tool, WINDOWS)).toEqual({
      kind: "winget",
      id: "Example.Example",
    });
  });

  test("falls back to u24 when u26 is omitted", () => {
    const same: Tool = { ...tool, u26: undefined };
    expect(providerFor(same, WSL26)).toEqual({ kind: "apt", pkg: "example" });
  });
});

describe("isInstalled", () => {
  test("managed tools always report not-installed so the provider decides", () => {
    // A font and a settings file cannot be probed with command -v.
    // Reporting them missing forever would be worse than useless.
    const managed: Tool = {
      name: "nerd-font",
      scope: "wsl",
      managed: true,
      u24: { kind: "builtin", name: "nerd-font" },
      win: { kind: "skip", reason: "host provides" },
    };
    expect(isInstalled(managed)).toBe(false);
  });
});

describe("the manifest itself", () => {
  test("every skip carries a reason", () => {
    // A skip is a decision. One without a reason is an undocumented gap
    // wearing a decision's clothes.
    for (const tool of TOOLS) {
      for (const provider of [tool.u24, tool.u26, tool.win]) {
        if (provider?.kind === "skip") {
          expect(provider.reason.length).toBeGreaterThan(0);
        }
      }
    }
  });

  test("tool names are unique within a scope", () => {
    for (const scope of ["core", "desktop", "wsl"] as const) {
      const names = toolsInScope(scope).map((t) => t.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  test("Debian-renamed tools declare the binaries to probe", () => {
    // ripgrep installs rg, bat installs batcat, fd-find installs fdfind.
    // Probing the logical name reports all three as missing on a machine
    // that plainly has them.
    const renamed = ["ripgrep", "bat", "fd", "neovim"];
    for (const name of renamed) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool?.cmd).toBeDefined();
      expect(tool!.cmd!.length).toBeGreaterThan(0);
    }
  });

  test("describeProvider covers every provider kind", () => {
    for (const tool of TOOLS) {
      for (const provider of [tool.u24, tool.u26, tool.win]) {
        if (!provider) continue;
        expect(describeProvider(provider)).not.toContain("undefined");
      }
    }
  });
});
