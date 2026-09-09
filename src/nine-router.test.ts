/**
 * The router as a standing service.
 *
 * Installed and stopped is what the agents see as broken: a host
 * configured against localhost:20128 fails its first request after
 * every boot until somebody opens a terminal and leaves `9router` in
 * it. These pin what red-dev writes to keep that from being the day.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Platform } from "./platform.ts";
import {
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  ROUTER_SERVICE,
  ROUTER_SHORTCUT,
  convergeRouterAutostart,
  inspectRouter,
  locateRouterPackage,
  removeRouterAutostart,
  routerDataDir,
  routerEnabled,
  routerHost,
  routerPort,
  routerServeCommand,
  routerServeEnv,
  routerUnit,
  routerUnitPath,
  routerWrapper,
  startupShortcutScript,
} from "./nine-router.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const WINDOWS: Platform = {
  ...UBUNTU,
  os: "windows",
  env: "windows",
  distro: null,
  version: null,
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

describe("the knobs", () => {
  test("loopback and 20128 unless somebody says otherwise", () => {
    expect(routerPort({})).toBe(DEFAULT_ROUTER_PORT);
    expect(routerHost({})).toBe(DEFAULT_ROUTER_HOST);
    expect(routerPort({ RED_9ROUTER_PORT: "3000" })).toBe(3000);
    expect(routerHost({ RED_9ROUTER_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  test("a port a user service cannot bind folds back to the default, rather than failing a converge", () => {
    expect(routerPort({ RED_9ROUTER_PORT: "80" })).toBe(DEFAULT_ROUTER_PORT);
    expect(routerPort({ RED_9ROUTER_PORT: "70000" })).toBe(DEFAULT_ROUTER_PORT);
    expect(routerPort({ RED_9ROUTER_PORT: "nonsense" })).toBe(DEFAULT_ROUTER_PORT);
  });

  test("the service turns off with one variable, and the package stays", () => {
    expect(routerEnabled({})).toBe(true);
    expect(routerEnabled({ RED_9ROUTER: "0" })).toBe(false);
  });

  test("the data directory is the package's own convention", () => {
    // Read from hooks/sqliteRuntime.js in the 0.5.69 tarball: DATA_DIR
    // wins, then %APPDATA%\9router, then ~/.9router. It matters because
    // the NODE_PATH the server needs points inside it.
    expect(routerDataDir({}, "linux", "/home/me")).toBe("/home/me/.9router");
    expect(routerDataDir({ DATA_DIR: "/srv/9r" }, "linux", "/home/me")).toBe("/srv/9r");
    expect(routerDataDir({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming", "9router"),
    );
  });
});

describe("finding the package under mise", () => {
  test("prefers `latest`, then the newest real version, and needs cli.js to be there", () => {
    const root = mkdtempSync(join(tmpdir(), "red-9router-"));
    const lay = (version: string, withCli: boolean) => {
      const pkg = join(root, "npm-9router", version, "node_modules", "9router");
      mkdirSync(pkg, { recursive: true });
      if (withCli) writeFileSync(join(pkg, "cli.js"), "");
      return pkg;
    };
    lay("0.5.9", true);
    const newest = lay("0.5.70", true);
    lay("0.5.71", false); // half an install: no cli.js yet
    expect(locateRouterPackage(root)).toBe(newest);

    const latest = lay("latest", true);
    expect(locateRouterPackage(root)).toBe(latest);
  });

  test("null before the manifest row has run", () => {
    expect(locateRouterPackage(mkdtempSync(join(tmpdir(), "red-9router-empty-")))).toBeNull();
  });
});

describe("the spawn the launcher would have made", () => {
  test("is node on the standalone server, in its own directory, with the launcher's flags", () => {
    // Read against cli.js in the 0.5.69 tarball: `custom-server.js`
    // where it ships, ipv4first, and the heap ceiling.
    const { argv, cwd } = routerServeCommand("/usr/bin/node", "/m/npm-9router/0.5.69/node_modules/9router", true);
    expect(argv[0]).toBe("/usr/bin/node");
    expect(argv).toContain("--dns-result-order=ipv4first");
    expect(argv).toContain("--max-old-space-size=6144");
    expect(argv.at(-1)).toBe("/m/npm-9router/0.5.69/node_modules/9router/app/custom-server.js");
    expect(cwd).toBe("/m/npm-9router/0.5.69/node_modules/9router/app");
  });

  test("falls back to server.js for a build without the peer-address wrapper", () => {
    const { argv } = routerServeCommand("node", "/p", false);
    expect(argv.at(-1)).toBe("/p/app/server.js");
  });

  test("the environment carries the SQLite runtime ahead of everything, and binds loopback", () => {
    const env = routerServeEnv({ NODE_PATH: "/existing", HOME: "/home/me" }, "/p", "/home/me/.9router", 20128, "127.0.0.1", ":");
    expect(env["NODE_PATH"]).toBe("/home/me/.9router/runtime/node_modules:/p/app/node_modules:/existing");
    expect(env["PORT"]).toBe("20128");
    expect(env["HOSTNAME"]).toBe("127.0.0.1");
    expect(env["HOME"]).toBe("/home/me");
  });
});

describe("the systemd unit", () => {
  const unit = routerUnit("/home/me/.local/share/mise/shims/red-dev", "/home/me/.local/bin:/mnt/c/Windows/system32");

  test("runs red-dev, not the path into mise's install, so an upgrade does not orphan it", () => {
    expect(unit).toContain("9router serve");
    expect(unit).not.toContain("npm-9router");
  });

  test("goes through a login shell with the converge's PATH behind it, like the watch unit", () => {
    expect(unit).toContain("/bin/bash -lc");
    expect(unit).toContain('PATH="$PATH:$RED_DEV_PATH"');
    expect(unit).toContain("RED_DEV_PATH=/home/me/.local/bin:/mnt/c/Windows/system32");
  });

  test("restarts on failure and not always, so a deliberate stop stays stopped", () => {
    expect(unit).toContain("Restart=on-failure");
    expect(unit).not.toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

describe("the Windows side", () => {
  test("the shortcut goes in the Startup folder, through the hidden runner, and is not a scheduled task", () => {
    // A task made by `schtasks /Create` carries the scheduler's default
    // three-day execution limit, after which it stops the router and
    // reports success. Explorer's Startup folder has no clock.
    const script = startupShortcutScript("C:\\r\\hidden-run.vbs", "C:\\r\\bin\\red-dev-9router.cmd");
    expect(script).toContain("Programs\\Startup");
    expect(script).toContain(ROUTER_SHORTCUT);
    expect(script).toContain("wscript.exe");
    expect(script).toContain('//B //Nologo "C:\\r\\hidden-run.vbs" "C:\\r\\bin\\red-dev-9router.cmd"');
    expect(script).not.toContain("schtasks");
  });

  test("saves only when something differs, so Explorer's registration is left alone", () => {
    const script = startupShortcutScript("r", "w");
    expect(script).toContain("'same'; exit 0");
    expect(script.indexOf("'same'")).toBeLessThan(script.indexOf("$s.Save()"));
  });

  test("the wrapper holds the quoting, CRLF and silent", () => {
    const wrapper = routerWrapper("C:\\Program Files\\red-dev\\red-dev.exe");
    expect(wrapper).toBe('@echo off\r\n"C:\\Program Files\\red-dev\\red-dev.exe" 9router serve\r\n');
  });
});

describe("converging the service", () => {
  test("a Linux host without systemd is told how to start it, and nothing is run", async () => {
    const calls: string[][] = [];
    const outcome = await convergeRouterAutostart(
      { ...UBUNTU, caps: { ...UBUNTU.caps, systemd: false } },
      { run: async (argv) => (calls.push(argv), { exitCode: 0 }) },
    );
    expect(outcome).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("writes the unit, reloads, enables now — and a second run touches nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-9router-home-"));
    const calls: string[][] = [];
    const seams = {
      home,
      env: { PATH: "/usr/bin" },
      binary: "/home/me/.local/bin/red-dev",
      run: async (argv: string[]) => (calls.push(argv), { exitCode: 0 }),
    };

    expect(await convergeRouterAutostart(UBUNTU, seams)).toBe("installed");
    expect(readFileSync(routerUnitPath(home), "utf8")).toBe(routerUnit("/home/me/.local/bin/red-dev", "/usr/bin"));
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", ROUTER_SERVICE],
    ]);

    calls.length = 0;
    expect(await convergeRouterAutostart(UBUNTU, seams)).toBe("unchanged");
    // Enabling an enabled unit is a no-op, and it is what catches a
    // service somebody stopped by hand. No reload, no restart.
    expect(calls).toEqual([["systemctl", "--user", "enable", "--now", ROUTER_SERVICE]]);
  });

  test("a unit whose text moved restarts the running service, which is reading the old one", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-9router-home-"));
    const calls: string[][] = [];
    const run = async (argv: string[]) => (calls.push(argv), { exitCode: 0 });
    await convergeRouterAutostart(UBUNTU, { home, env: {}, binary: "/old/red-dev", run });
    calls.length = 0;

    expect(await convergeRouterAutostart(UBUNTU, { home, env: {}, binary: "/new/red-dev", run })).toBe("installed");
    expect(calls).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", ROUTER_SERVICE],
      ["systemctl", "--user", "restart", ROUTER_SERVICE],
    ]);
  });

  test("turning it off disables before deleting, and does nothing on a machine that never had it", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-9router-home-"));
    const calls: string[][] = [];
    const run = async (argv: string[]) => (calls.push(argv), { exitCode: 0 });

    expect(await convergeRouterAutostart(UBUNTU, { home, env: { RED_9ROUTER: "0" }, run })).toBe("unchanged");
    expect(calls).toEqual([]);

    await convergeRouterAutostart(UBUNTU, { home, env: {}, binary: "/b/red-dev", run });
    calls.length = 0;
    expect(await convergeRouterAutostart(UBUNTU, { home, env: { RED_9ROUTER: "0" }, run })).toBe("removed");
    expect(calls[0]).toEqual(["systemctl", "--user", "disable", "--now", ROUTER_SERVICE]);
    expect(calls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
  });

  test("on Windows a silent port is started now, because the shortcut only fires at the next logon", async () => {
    const started: string[][] = [];
    const calls: string[][] = [];
    process.env["LOCALAPPDATA"] ??= mkdtempSync(join(tmpdir(), "red-9router-lad-"));
    const outcome = await convergeRouterAutostart(WINDOWS, {
      binary: "C:\\b\\red-dev.exe",
      env: {},
      hiddenRunner: async () => "C:\\r\\hidden-run.vbs",
      answering: async () => false,
      startHidden: (runner, wrapper) => started.push([runner, wrapper]),
      run: async (argv) => (calls.push(argv), { exitCode: 0, out: "written" }),
    });
    expect(outcome).toBe("installed");
    expect(started).toHaveLength(1);
    expect(started[0]![0]).toBe("C:\\r\\hidden-run.vbs");
    expect(started[0]![1]).toEndWith("red-dev-9router.cmd");
    expect(calls[0]![0]).toBe("powershell.exe");
  });

  test("uninstall takes the unit out and leaves ~/.9router, which holds the person's credentials", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-9router-home-"));
    const calls: string[][] = [];
    const run = async (argv: string[]) => (calls.push(argv), { exitCode: 0 });
    await convergeRouterAutostart(UBUNTU, { home, env: {}, binary: "/b/red-dev", run });
    const removed = await removeRouterAutostart(UBUNTU, { home, run });
    expect(removed).toEqual([routerUnitPath(home)]);
    expect(removed.some((r) => r.includes(".9router"))).toBe(false);
  });
});

describe("what doctor says", () => {
  const systemctl = (enabled: boolean, active: boolean) => async (argv: string[]) => {
    if (argv.includes("is-enabled")) return { exitCode: enabled ? 0 : 1 };
    if (argv.includes("is-active")) return { exitCode: active ? 0 : 1 };
    return { exitCode: 0 };
  };

  test("enabled, running and answering is ok", async () => {
    const [check] = await inspectRouter(UBUNTU, { env: {}, run: systemctl(true, true), answering: async () => true });
    expect(check).toMatchObject({ name: "9router", status: "ok" });
  });

  test("a running service and a silent port points at the journal, not at the converge", async () => {
    const [check] = await inspectRouter(UBUNTU, { env: {}, run: systemctl(true, true), answering: async () => false });
    expect(check?.status).toBe("drift");
    expect(check?.fix).toContain("journalctl");
  });

  test("a foreground `9router` somebody left running is not a service", async () => {
    const [check] = await inspectRouter(UBUNTU, { env: {}, run: systemctl(false, false), answering: async () => true });
    expect(check?.status).toBe("drift");
    expect(check?.fix).toBe("red-dev install core");
  });

  test("turned off is ok and says so, rather than drift forever", async () => {
    const [check] = await inspectRouter(UBUNTU, { env: { RED_9ROUTER: "0" }, run: async () => ({ exitCode: 0 }) });
    expect(check).toMatchObject({ status: "ok" });
    expect(check?.detail).toContain("RED_9ROUTER=0");
  });
});
