import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appLogPath, logOpener, openLog } from "./diagnostic-logs.ts";
import { buildCli, parseArgs } from "./cli.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("diagnostic log access", () => {
  test("parses app/path/open and keeps existing run selectors", () => {
    const cli = buildCli();
    expect(parseArgs(cli, ["logs", "--app", "red-router", "--path"])).toMatchObject({ errors: [], logsApp: "red-router", logsPath: true });
    expect(parseArgs(cli, ["logs", "crash", "--open"])).toMatchObject({ errors: [], logsWhich: "crash", logsOpen: true });
    expect(parseArgs(cli, ["logs", "2"])).toMatchObject({ errors: [], logsWhich: "2" });
  });

  test("resolves all platform contracts, ignoring relative state roots", () => {
    expect(appLogPath("red-router", { platform: "linux", home: "/h", env: { XDG_STATE_HOME: "/state" } })).toBe("/state/red-router/logs/red-router.log");
    expect(appLogPath("redskilled", { platform: "linux", home: "/h", env: { XDG_STATE_HOME: "relative" } })).toBe("/h/.local/state/redskilled/logs/daemon.log");
    expect(appLogPath("redskilled", { platform: "darwin", home: "/h", env: {} })).toBe("/h/Library/Logs/redskilled/daemon.log");
    expect(appLogPath("red-router", { platform: "win32", home: "C:\\Users\\me", env: { HOME: "/wrong", LOCALAPPDATA: "C:\\Local" } })).toBe("C:\\Local\\red-router\\logs\\red-router.log");
  });

  test("preserves RedCode canonical and unmigrated fallback paths", () => {
    expect(appLogPath("redcode", { platform: "linux", home: "/h", env: {}, exists: () => false })).toBe("/h/.red/code/data/log/redcode.log");
    expect(appLogPath("redcode", { platform: "linux", home: "/h", env: {}, exists: p => p.endsWith("redcode") })).toBe("/h/.red/redcode/data/log/redcode.log");
  });

  test("keeps filenames out of shell source", () => {
    const path = '/tmp/log $HOME; " &.log';
    expect(logOpener(path, "linux").argv).toEqual(["xdg-open", path]);
    expect(logOpener(path, "darwin").argv).toEqual(["open", path]);
    const windows = logOpener(path, "win32");
    expect(windows.env?.RED_DEV_OPEN_LOG).toBe(path);
    expect(windows.argv.join(" ")).not.toContain(path);
  });

  test("path query neither creates files nor launches an older app", async () => {
    const root = mkdtempSync(join(tmpdir(), "red-dev-log-query-")); roots.push(root);
    const child = Bun.spawn([process.execPath, new URL("./main.ts", import.meta.url).pathname, "logs", "--app", "red-router", "--path"], {
      env: { ...process.env, HOME: root, XDG_STATE_HOME: join(root, "state") }, stdout: "pipe", stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe(join(root, "state", "red-router", "logs", "red-router.log"));
    expect(existsSync(join(root, "state"))).toBe(false);
    await expect(openLog(join(root, "missing.log"))).rejects.toThrow("does not exist");
  });
});
