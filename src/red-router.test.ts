import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  convergeRouterAutostart,
  removeRouterAutostart,
  inspectRouter,
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  LEGACY_ROUTER_SERVICE,
  ROUTER_SERVICE,
  routerEnabled,
  routerHost,
  routerPort,
  routerServiceNeedsRestart,
  routerServiceConfiguration,
  routerWrapper,
  updateRouterWrapper,
} from "./red-router.ts";
import type { Platform } from "./platform.ts";

const SYSTEMD: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

describe("RedRouter service contract", () => {
  test("uses the official package defaults and service name", () => {
    expect(ROUTER_SERVICE).toBe("red-router.service");
    expect(LEGACY_ROUTER_SERVICE).toBe("red-dev-9router.service");
    expect(routerPort({})).toBe(DEFAULT_ROUTER_PORT);
    expect(routerHost({})).toBe(DEFAULT_ROUTER_HOST);
    expect(routerPort({ RED_ROUTER_PORT: "26000" })).toBe(26000);
    expect(routerHost({ RED_ROUTER_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(routerEnabled({ RED_ROUTER: "0" })).toBe(false);
  });

  test("Windows starts the official command in tray mode", () => {
    expect(routerWrapper("C:\\mise.exe")).toContain(
      '"C:\\mise.exe" exec red-router -- red-router -t --skip-update -n',
    );
    expect(routerWrapper("C:\\mise.exe")).not.toContain(" -H ");
    expect(routerWrapper("C:\\mise.exe")).not.toContain(" -p ");
  });

  test("Windows retires generated bind flags with an exact backup and preserves unknown wrappers", () => {
    const dir = mkdtempSync(join(tmpdir(), "red-router-wrapper-retirement-"));
    const path = join(dir, "router.cmd");
    const legacy = '@echo off\r\n"C:\\mise.exe" exec red-router -- red-router -t --skip-update -n -p 26400 -H "0.0.0.0"\r\n';
    try {
      writeFileSync(path, legacy);
      expect(updateRouterWrapper(path, "C:\\mise.exe")).toBe("changed");
      expect(readFileSync(path, "utf8")).toBe(routerWrapper("C:\\mise.exe"));
      const backups = readdirSync(dir).filter((name) => name.endsWith(".bak"));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dir, backups[0]!), "utf8")).toBe(legacy);
      expect(updateRouterWrapper(path, "C:\\mise.exe")).toBe("unchanged");
      expect(readdirSync(dir).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
      const custom = "@echo off\r\nREM Operator-owned launcher\r\ncustom-router.exe\r\n";
      writeFileSync(path, custom);
      expect(updateRouterWrapper(path, "C:\\mise.exe")).toBe("unowned");
      expect(readFileSync(path, "utf8")).toBe(custom);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("restarts a live service only when its generated definition moved", () => {
    expect(routerServiceNeedsRestart("old", "new", true)).toBe(true);
    expect(routerServiceNeedsRestart("same", "same", true)).toBe(false);
    expect(routerServiceNeedsRestart(null, "new", false)).toBe(false);
    expect(routerServiceNeedsRestart("old", null, true)).toBe(false);
  });

  test("the postinstall reloads a live router after its installer repoints the unit", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-postinstall-"));
    const unit = join(home, ".config/systemd/user/red-router.service");
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(unit, "ExecStart=/old/red-router\n");
    const calls: string[][] = [];

    const outcome = await convergeRouterAutostart(SYSTEMD, {
      home,
      routerBinary: "/fixture/red-router",
      miseBinary: null,
      run: async (argv) => {
        calls.push(argv);
        if (argv.join(" ") === "systemctl --user is-active red-router.service") return { exitCode: 0 };
        if (argv[0] === "/fixture/red-router") writeFileSync(unit, "ExecStart=/new/red-router\n");
        return { exitCode: argv.includes("is-enabled") ? 1 : 0 };
      },
    });

    expect(outcome).toBe("installed");
    expect(calls).toContainEqual(["systemctl", "--user", "restart", "red-router.service"]);
  });

  describe("a restart that reports failure", () => {
    /** A live router whose definition moved, with `restart` failing and `is-active` scripted. */
    async function converge(isActive: number[], answering: boolean) {
      const home = mkdtempSync(join(tmpdir(), "red-router-restart-race-"));
      const unit = join(home, ".config/systemd/user/red-router.service");
      mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
      writeFileSync(unit, "ExecStart=/old/red-router\n");
      const calls: string[][] = [];
      let polls = 0;
      const outcome = convergeRouterAutostart(SYSTEMD, {
        home,
        routerBinary: "/fixture/red-router",
        miseBinary: null,
        answering: async () => answering,
        sleep: async () => {},
        run: async (argv) => {
          calls.push(argv);
          if (argv.join(" ") === "systemctl --user is-active red-router.service") {
            return { exitCode: isActive[Math.min(polls++, isActive.length - 1)] ?? 0 };
          }
          if (argv[0] === "/fixture/red-router") writeFileSync(unit, "ExecStart=/new/red-router\n");
          if (argv.includes("restart")) return { exitCode: 1 };
          return { exitCode: argv.includes("is-enabled") ? 1 : 0 };
        },
      });
      return { outcome, calls };
    }

    test("is not a failure when the supervisor's retry brings the router up", async () => {
      // Was active before the restart, then activating twice, then serving:
      // the shape of a start that lost the port to the old server for a moment.
      const { outcome, calls } = await converge([0, 3, 3, 0], true);
      expect(await outcome).toBe("installed");
      expect(calls.filter((argv) => argv.includes("is-active"))).toHaveLength(4);
    });

    test("still fails when the router never comes back", async () => {
      const { outcome } = await converge([0, 3], false);
      await expect(outcome).rejects.toThrow("could not be restarted");
    });

    test("does not count an active unit whose port is silent as serving", async () => {
      const { outcome } = await converge([0, 0], false);
      await expect(outcome).rejects.toThrow("could not be restarted");
    });
  });

  test("mise postinstall uses the exact package it just installed and retries a transient failure", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-mise-postinstall-"));
    const installPath = join(home, "mise-install");
    const binary = join(installPath, "node_modules", ".bin", "red-router");
    mkdirSync(join(installPath, "node_modules", ".bin"), { recursive: true });
    writeFileSync(binary, "");
    const calls: string[][] = [];
    let installs = 0;

    await convergeRouterAutostart(SYSTEMD, {
      home,
      env: { MISE_TOOL_INSTALL_PATH: installPath },
      miseBinary: null,
      run: async (argv) => {
        calls.push(argv);
        if (argv[0] === binary) return { exitCode: ++installs === 1 ? 1 : 0 };
        return { exitCode: 1 };
      },
    });

    expect(installs).toBe(2);
    expect(calls.filter((argv) => argv[0] === binary)).toEqual([
      [binary, "service", "install"],
      [binary, "service", "install"],
    ]);
  });

  test("upgrades delegate network choices to RedRouter and diagnostics read its saved configuration", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-network-owner-"));
    const unit = join(home, ".config/systemd/user/red-router.service");
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    const original = [
      "Description=RedRouter AI routing gateway",
      "# Operator-owned network choice",
      "ExecStart=/old/red-router",
      'Environment="RED_ROUTER_PORT=26400"',
      'Environment="RED_ROUTER_SERVER_HOST=0.0.0.0"',
      "",
    ].join("\n");
    writeFileSync(unit, original);
    const calls: string[][] = [];
    const seams = {
      home,
      // Even old red-dev defaults must not be passed as Router configuration.
      env: { RED_ROUTER_PORT: "25050", RED_ROUTER_HOST: "127.0.0.1" },
      routerBinary: "/fixture/red-router",
      miseBinary: null,
      answering: async () => true,
      run: async (argv: string[]) => {
        calls.push(argv);
        if (argv[0] === "/fixture/red-router") {
          expect(argv).toEqual(["/fixture/red-router", "service", "install"]);
          writeFileSync(unit, original.replace("/old/red-router", "/new/red-router"));
        }
        return { exitCode: 0 };
      },
    };
    try {
      expect(await convergeRouterAutostart(SYSTEMD, seams)).toBe("installed");
      expect(routerServiceConfiguration(readFileSync(unit, "utf8"))).toEqual({
        port: 26400,
        host: "0.0.0.0",
      });
      expect(readFileSync(unit, "utf8").replace("/new/red-router", "/old/red-router")).toBe(original);
      const [status] = await inspectRouter(SYSTEMD, seams);
      expect(status?.status).toBe("ok");
      expect(status?.detail).toContain("http://0.0.0.0:26400");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("saved service diagnostics reject unrelated or malformed units", () => {
    expect(routerServiceConfiguration('Environment="RED_ROUTER_SERVER_HOST=0.0.0.0"')).toBeNull();
    expect(routerServiceConfiguration('Description=RedRouter AI routing gateway\nEnvironment="RED_ROUTER_PORT=70000"\nEnvironment="RED_ROUTER_SERVER_HOST=0.0.0.0"')).toBeNull();
  });
});


describe("router uninstall ownership", () => {
  test("a temporary home with no owned units never reaches the real session manager", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-uninstall-empty-"));
    try {
      const calls: string[][] = [];
      expect(await removeRouterAutostart(SYSTEMD, { home, run: async (argv) => {
        calls.push(argv); throw new Error("must not execute a system command");
      } })).toEqual([]);
      expect(calls).toEqual([]);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("unknown units survive without stop, disable or reload", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-uninstall-foreign-"));
    try {
      const dir = join(home, ".config/systemd/user"); mkdirSync(dir, { recursive: true });
      const path = join(dir, ROUTER_SERVICE); writeFileSync(path, "[Service]\nExecStart=/personal/router\n");
      expect(await removeRouterAutostart(SYSTEMD, { home, run: async () => {
        throw new Error("must not touch another owner's service");
      } })).toEqual([]);
      expect(readFileSync(path, "utf8")).toContain("/personal/router");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test("owned legacy units are backed up and a failed stop leaves their bytes for retry", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-uninstall-retry-"));
    try {
      const dir = join(home, ".config/systemd/user"); mkdirSync(dir, { recursive: true });
      const path = join(dir, LEGACY_ROUTER_SERVICE);
      const bytes = "# Generated by red-dev.\r\n[Service]\r\nExecStart=/owned/9router serve\r\n";
      writeFileSync(path, bytes);
      const calls: string[][] = []; let fail = true;
      const run = async (argv: string[]) => {
        calls.push(argv); return { exitCode: fail && argv.includes("disable") ? 1 : 0 };
      };
      await expect(removeRouterAutostart(SYSTEMD, { home, run })).rejects.toThrow("retirement failed");
      expect(readFileSync(path, "utf8")).toBe(bytes);
      expect(readFileSync(`${path}.red-dev-uninstall.bak`, "utf8")).toBe(bytes);
      fail = false;
      expect(await removeRouterAutostart(SYSTEMD, { home, run })).toEqual([path]);
      const before = calls.length;
      expect(await removeRouterAutostart(SYSTEMD, { home, run })).toEqual([]);
      expect(calls.length).toBe(before);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
