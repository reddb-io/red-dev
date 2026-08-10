import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import {
  TOOLS,
  applicableScopes,
  describeProvider,
  installState,
  isInstalled,
  itemsNeedingAdmin,
  needsAdmin,
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
const DARWIN = platform({
  os: "darwin",
  env: "desktop",
  distro: null,
  version: null,
  caps: { apt: false, gui: true, systemd: false, winget: false, flatpak: false },
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

  test("rejects Darwin before selecting a Linux provider", () => {
    expect(() => providerFor(tool, DARWIN)).toThrow(
      "unsupported platform: darwin. macOS support is planned in Phase 5 as an adapter of the platform contracts; this is not a broken Ubuntu install.",
    );
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
  test("Linux desktop declares wl-clipboard for Zellij copy", () => {
    const tool = TOOLS.find((t) => t.name === "wl-clipboard");
    expect(tool?.scope).toBe("desktop");
    expect(providerFor(tool!, DESKTOP)).toEqual({ kind: "apt", pkg: "wl-clipboard" });
  });

  test("a package that ships no binary is still findable", () => {
    // The regression this pins: bash-completion installs a shell library
    // and nothing executable, so the default probe looked for a command
    // called `bash-completion` on PATH, never found one, and reported
    // the package absent on a machine where dpkg said `install ok
    // installed`. Every converge then tried to install it again and
    // named it as a problem — the same failure, once per run, forever.
    //
    // Asserted through installState rather than by reading the field, so
    // deleting the declaration fails here even if the field survives.
    const tool = TOOLS.find((t) => t.name === "bash-completion");
    expect(tool?.file).toBe("/usr/share/bash-completion/bash_completion");
    expect(tool?.cmd).toBeUndefined();

    const seen = { ...tool!, file: import.meta.path } as typeof tool;
    expect(installState(seen!)).toBe("ok");

    const missing = { ...tool!, file: "/nonexistent/bash_completion" } as typeof tool;
    expect(installState(missing!)).toBe("absent");
  });

  test("what init.sh sources, the manifest installs", () => {
    // The gap this closes: init.sh sourced bash_completion from the
    // first version and nothing ever declared the package. On a desktop
    // Ubuntu it arrives as somebody else's dependency, so the `[ -r ]`
    // guard around the source line always passed and the omission was
    // invisible — until a trimmed WSL image, where bash silently loses
    // completion for git, apt and ssh.
    //
    // Asserted against init.sh rather than as a bare name, so deleting
    // the source line and leaving the package, or the reverse, is what
    // fails here.
    const init = readFileSync("config/bash/init.sh", "utf8");
    expect(init).toContain("/usr/share/bash-completion/bash_completion");

    const tool = TOOLS.find((t) => t.name === "bash-completion");
    expect(tool?.scope).toBe("core");
    expect(providerFor(tool!, WSL24)).toEqual({ kind: "apt", pkg: "bash-completion" });
  });

  test("webm2mp4's ffmpeg dependency is declared", () => {
    const tool = TOOLS.find((t) => t.name === "ffmpeg");
    expect(tool?.scope).toBe("core");
    expect(providerFor(tool!, WSL24)).toEqual({ kind: "apt", pkg: "ffmpeg" });
    expect(providerFor(tool!, WINDOWS)).toEqual({ kind: "winget", id: "Gyan.FFmpeg" });
  });

  test("red-ui consumes the current Windows release asset", () => {
    const tool = TOOLS.find((t) => t.name === "red-ui");
    expect(providerFor(tool!, WINDOWS)).toEqual({
      kind: "gh",
      repo: "reddb-io/red-ui",
      asset: "red-ui-windows-x86_64-setup.exe",
      silentArgs: ["/S"],
    });
  });

  test("a clean Windows plan includes red-ui", () => {
    const plan = applicableScopes(WINDOWS)
      .flatMap((scope) => toolsInScope(scope))
      .filter((tool) => providerFor(tool, WINDOWS).kind !== "skip")
      .map((tool) => tool.name);
    expect(plan).toContain("red-ui");
  });

  test("Ubuntu desktop installs the configured Nerd Font", () => {
    const plan = applicableScopes(DESKTOP)
      .flatMap((scope) => toolsInScope(scope))
      .filter((tool) => providerFor(tool, DESKTOP).kind !== "skip")
      .map((tool) => tool.name);
    expect(plan).toContain("nerd-font");
  });

  test("native Windows installs the configured Nerd Font", () => {
    const plan = applicableScopes(WINDOWS)
      .flatMap((scope) => toolsInScope(scope))
      .filter((tool) => providerFor(tool, WINDOWS).kind !== "skip")
      .map((tool) => tool.name);
    expect(plan).toContain("nerd-font");
  });

  test("WSL keeps installing the font on the Windows host", () => {
    const plan = applicableScopes(WSL24)
      .flatMap((scope) => toolsInScope(scope))
      .filter((tool) => providerFor(tool, WSL24).kind !== "skip")
      .map((tool) => tool.name);
    expect(plan).toContain("nerd-font");
  });

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

/**
 * PowerShell an unelevated session cannot run at all.
 *
 * Every one of these returns access-denied without administrator, which
 * is what makes the manifest's declaration checkable instead of a claim
 * somebody typed. Self-elevation is deliberately not on the list:
 * `Start-Process -Verb RunAs` runs perfectly well unelevated — raising a
 * prompt is what it does — so finding it says nothing about whether the
 * item's own work needs rights.
 */
const ADMIN_OPERATIONS = [
  "Add-WindowsCapability",
  "Enable-WindowsOptionalFeature",
  "New-NetFirewallRule",
  "Set-Service",
  "Start-Service",
  "Stop-Service",
];

/**
 * Which manifest item each privileged module implements.
 *
 * Written down rather than derived from the filename, because only some
 * builtins are named after their module. Both directions are asserted
 * below, so this cannot quietly drift from the code it describes.
 */
const PRIVILEGED_MODULES: Record<string, string> = {
  "ssh-server.ts": "ssh-server",
};

/**
 * A module's code with its comments removed.
 *
 * ssh-server.ts explains Add-WindowsCapability at length before running
 * it, and a prose mention is not a call — without this, documenting the
 * problem somewhere would be enough to trip the check.
 */
function codeOf(file: string): string {
  return readFileSync(`src/${file}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function runsPrivilegedOperations(file: string): boolean {
  const code = codeOf(file);
  return ADMIN_OPERATIONS.some((op) => code.includes(op));
}

describe("items that need administrator", () => {
  test("a Windows target names them", () => {
    // The answer arrives from data, with nothing executed and no Windows
    // host in sight — which is the whole point: `plan` has to be able to
    // announce this before the first install rather than after item 36.
    expect(itemsNeedingAdmin(WINDOWS).map((t) => t.name)).toEqual(["ssh-server"]);
  });

  test("a Linux target needs administrator for nothing", () => {
    // Not symmetrical, and that asymmetry is the reason the declaration
    // sits on the provider column rather than on the tool: Ubuntu
    // installs openssh-server through the same sudo path as every other
    // apt package, and must not be charged for a Windows requirement.
    for (const p of [DESKTOP, WSL24, WSL26, platform({ env: "server" })]) {
      expect(itemsNeedingAdmin(p)).toEqual([]);
    }
  });

  test("the SSH server declares it on Windows and not on Ubuntu", () => {
    const tool = TOOLS.find((t) => t.name === "ssh-server");
    expect(needsAdmin(providerFor(tool!, WINDOWS))).toBe(true);
    expect(needsAdmin(providerFor(tool!, WSL24))).toBe(false);
    expect(needsAdmin(providerFor(tool!, WSL26))).toBe(false);
  });

  test("every module running privileged operations is accounted for", () => {
    // The half that catches a provider which quietly starts needing
    // administrator: a new module reaching for one of these cmdlets
    // fails here until somebody says which item it belongs to, and a
    // module that stops needing them fails here until it is removed.
    const found = readdirSync("src")
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .filter(runsPrivilegedOperations)
      .sort();
    expect(found).toEqual(Object.keys(PRIVILEGED_MODULES).sort());
  });

  test("and each of them declares it in the manifest", () => {
    // Delete `admin(...)` from the ssh-server row and this is what goes
    // red, while the PowerShell that needs the rights sits untouched.
    for (const [file, name] of Object.entries(PRIVILEGED_MODULES)) {
      const tool = TOOLS.find((t) => t.name === name);
      expect(tool).toBeDefined();
      expect([file, needsAdmin(tool!.win)]).toEqual([file, true]);
    }
  });
});
