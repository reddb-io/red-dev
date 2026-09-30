import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeCmd, bridgePowerShell, nativeOwnerArgv, ownedDaemonLauncher, ownedRouterWrapper, prepareWindowsRouterData, retireWindowsServices, routerImportCommand, snapshotRouterData } from "./windows-wsl-migration.ts";
import { launcherFor, runtimeBinDir } from "./red-skills-companions.ts";
import type { Platform } from "./platform.ts";

const windows: Platform = { os: "windows", env: "windows", workstation: "windows-wsl", distro: null, version: null, codename: null, arch: "x64", caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false } };
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "red-dev migration ")); temporary.push(dir); return dir; }
function native() {
  const home = temp(), bin = join(home, "bin"), daemonBin = runtimeBinDir(home);
  mkdirSync(bin, { recursive: true }); mkdirSync(daemonBin, { recursive: true });
  const daemon = launcherFor(windows, { bin: daemonBin, current: "C:/Users/person/.red/skills/current" }, "redskilled", "dist/redskilled.bundle.min.mjs");
  writeFileSync(daemon.path, daemon.bytes);
  const router = join(bin, "red-dev-red-router.cmd");
  writeFileSync(router, '@echo off\r\n"C:/mise/mise.exe" exec red-router -- red-router -t --skip-update -n -p 20128 -H "0.0.0.0"\r\n');
  const calls: string[][] = [];
  const stopped = new Set<string>();
  const run = async (argv: string[]) => {
    calls.push(argv);
    if (argv.includes("stop") || argv.join(" ").includes("'stop'")) stopped.add(argv.join(" ").includes("red-router") ? "router" : "daemon");
    const command = argv.join(" ");
    const kind = command.includes("redskilled.bundle") ? "daemon" : "router";
    return { exitCode: 0, stdout: command.includes("Win32_Process") && stopped.has(kind) ? "0" : "1" };
  };
  return { home, bin, daemon, router, calls, run, root: join(home, ".local/state/red-dev/windows-wsl") };
}

describe("Windows service destination migration", () => {
  test("recognizes the actual generated bundle launcher and preserves unknown launchers", () => {
    const f = native();
    expect(ownedDaemonLauncher(f.daemon.bytes)).toBe(true);
    expect(ownedRouterWrapper(readFileSync(f.router, "utf8"))).toBe(true);
    expect(ownedDaemonLauncher('node "custom.mjs" %*')).toBe(false);
    expect(ownedRouterWrapper('@echo off\ncustom-router')).toBe(false);
  });

  test("unknown replacement ownership blocks all native process actions", async () => {
    const f = native(); const target = join(f.bin, "red-router.cmd"); writeFileSync(target, "user launcher");
    await expect(retireWindowsServices(windows, "Ubuntu-26.04", { ...f, workers: async () => 0 })).rejects.toThrow("ownership unknown");
    expect(f.calls).toEqual([]); expect(readFileSync(target, "utf8")).toBe("user launcher");
    expect(existsSync(f.daemon.path)).toBe(true);
  });

  test("active or unknown Workers retain native launchers and supervisors", async () => {
    for (const workers of [2, null]) {
      const f = native();
      await expect(retireWindowsServices(windows, "Ubuntu-26.04", { ...f, workers: async () => workers })).rejects.toThrow("Workers");
      expect(f.calls.every(args => args[0] === "powershell.exe" && !/Copy-Item|'stop'/.test(args.join(" ")))).toBe(true);
      expect(readFileSync(f.daemon.path, "utf8")).toBe(f.daemon.bytes);
      expect(existsSync(join(f.root, "services-retired.json"))).toBe(false);
    }
  });

  test("archives exact owned bytes, calls owners through executable paths, creates bridges and retries uneventfully", async () => {
    const f = native(); const original = readFileSync(f.router, "utf8");
    const data = join(f.home, ".red/redskilled/user-data"); mkdirSync(data, { recursive: true }); writeFileSync(join(data, "keep"), "work");
    const seams = { ...f, workers: async () => 0, routerExecutable: () => "C:/mise/installs/red-router/1/bin/red-router.cmd" };
    await retireWindowsServices(windows, "Ubuntu-26.04", seams);
    expect(f.calls).toContainEqual(nativeOwnerArgv(f.daemon.path, ["stop"]));
    expect(f.calls).toContainEqual(nativeOwnerArgv("C:/mise/installs/red-router/1/bin/red-router.cmd", ["stop"]));
    expect(f.calls.some(args => args.includes("red-router") && args.includes("uninstall"))).toBe(true);
    expect(existsSync(f.router)).toBe(false);
    const archives = readdirSync(f.root).filter(name => /\.cmd\./.test(name)).map(name => readFileSync(join(f.root, name), "utf8"));
    expect(archives).toContain(f.daemon.bytes); expect(archives).toContain(original);
    expect(readFileSync(f.daemon.path, "utf8")).toContain("delegated to Ubuntu/WSL");
    expect(readFileSync(join(f.bin, "red-router-wsl.ps1"), "utf8")).toContain("Ubuntu-26.04");
    expect(readFileSync(join(data, "keep"), "utf8")).toBe("work");
    const count = f.calls.length; await retireWindowsServices(windows, "Ubuntu-26.04", seams);
    expect(f.calls.length).toBe(count);
  });

  test("a failed native stop keeps originals and is retried", async () => {
    const f = native();
    await expect(retireWindowsServices(windows, "Ubuntu-26.04", { ...f, workers: async () => 0, run: async argv => ({ exitCode: argv.join(" ").includes("'stop'") ? 1 : 0, stdout: "1" }) })).rejects.toThrow("stop cleanly");
    expect(readFileSync(f.daemon.path, "utf8")).toBe(f.daemon.bytes);
    expect(existsSync(f.router)).toBe(true);
    expect(existsSync(join(f.root, "services-retired.json"))).toBe(false);
  });

  test("consistent snapshot includes uncheckpointed WAL rows and preserves the source and encryption key", () => {
    const root = temp(), source = join(root, "source"); mkdirSync(source);
    const db = new Database(join(source, "storage.sqlite"));
    try {
      db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE items (name TEXT); INSERT INTO items VALUES ('uncheckpointed')");
      writeFileSync(join(source, ".env"), "OTHER=preserved\nSTORAGE_ENCRYPTION_KEY=old\n");
      const snapshot = snapshotRouterData(source, join(root, "backup"), "fixture-key")!;
      const copy = new Database(join(snapshot, "storage.sqlite"), { readonly: true });
      try { expect(copy.query("SELECT name FROM items").all()).toEqual([{ name: "uncheckpointed" }]); } finally { copy.close(); }
      expect(db.query("SELECT name FROM items").all()).toEqual([{ name: "uncheckpointed" }]);
      expect(readFileSync(join(source, ".env"), "utf8")).toContain("STORAGE_ENCRYPTION_KEY=old");
      expect(readFileSync(join(snapshot, ".env"), "utf8")).toContain('STORAGE_ENCRYPTION_KEY="fixture-key"');
      expect(snapshotRouterData(source, join(root, "backup"), "fixture-key")).toBe(snapshot);
      if (process.platform !== "win32") expect(statSync(join(snapshot, "storage.sqlite")).mode & 0o777).toBe(0o600);
    } finally { db.close(); }
  });

  test.skipIf(process.platform === "win32")("imports into an empty WSL home and preserves existing distro data", async () => {
    const home = temp(), source = join(home, "Windows snapshot's data"); mkdirSync(source); writeFileSync(join(source, "settings.json"), "original");
    const command = `wslpath() { printf '%s' "$2"; }; ${routerImportCommand(source)}`;
    const invoke = () => Bun.spawnSync(["bash", "-c", command], { env: { ...process.env, HOME: home }, stdout: "pipe", stderr: "pipe" });
    expect(invoke().exitCode).toBe(0); const dest = join(home, ".red/router/settings.json");
    expect(readFileSync(dest, "utf8")).toBe("original");
    writeFileSync(dest, "existing WSL data"); expect(invoke().exitCode).toBe(0);
    expect(readFileSync(dest, "utf8")).toBe("existing WSL data"); expect(readFileSync(join(source, "settings.json"), "utf8")).toBe("original");
  });

  test("a previous migration of a different distro still preserves/imports Windows data", async () => {
    const f = native(), source = join(f.home, "router"); mkdirSync(source); writeFileSync(join(source, "settings.json"), "data");
    mkdirSync(f.root, { recursive: true }); writeFileSync(join(f.root, "services-retired.json"), JSON.stringify({ distro: "Ubuntu-24.04" }));
    const calls: string[] = []; const run = async (_d: string, cmd: string) => { calls.push(cmd); return 0; };
    const seams = { home: f.home, env: { RED_ROUTER_DATA_DIR: source } };
    await prepareWindowsRouterData(windows, "Ubuntu-26.04", run, seams); expect(calls.length).toBe(1);
    await prepareWindowsRouterData(windows, "Ubuntu-24.04", run, seams); expect(calls.length).toBe(1);
  });

  test("bridge rejects unsupported paths and quotes the chosen distro", () => {
    expect(bridgePowerShell("Ubuntu's distro", "redskilled")).toContain("'Ubuntu''s distro'");
    expect(bridgePowerShell("Ubuntu", "redskilled")).toContain('"$@"');
    expect(() => bridgeCmd('C:/bad%path/script.ps1')).toThrow("unsupported bridge path");
  });
});
