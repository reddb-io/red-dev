import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireUpdateUnits } from "./retire-update-schedule.ts";
import { windowsOwnsMaintenance } from "./maintenance-owner.ts";
import { autoUpdateUnits, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER } from "./auto-update-schedule.ts";
import { convergeWatchSchedule, watchWrapper, WATCH_SERVICE } from "./watch-schedule.ts";
import type { Platform } from "./platform.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
function home() { const root = mkdtempSync(join(tmpdir(), "red-maintenance-life-")); roots.push(root); return root; }
test("failed timer retirement retains exact bytes, retries safely and never stops the updater service", async () => {
  const root = home(); const dir = join(root, ".config/systemd/user"); mkdirSync(dir, { recursive: true });
  const pair = autoUpdateUnits("/owned/red-dev", 60);
  writeFileSync(join(dir, AUTO_UPDATE_SERVICE), pair.service); writeFileSync(join(dir, AUTO_UPDATE_TIMER), pair.timer);
  const calls: string[][] = [];
  const run = async (argv: string[]) => { calls.push(argv); return { exitCode: calls.length === 1 ? 1 : 0 }; };
  await expect(retireUpdateUnits(root, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER, "update --unattended", run)).rejects.toThrow("pending");
  expect(readFileSync(join(dir, AUTO_UPDATE_SERVICE), "utf8")).toBe(pair.service);
  expect(await retireUpdateUnits(root, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER, "update --unattended", run)).toBe(true);
  const backup = join(root, ".local/state/red-dev/retired-update-triggers");
  expect(readdirSync(backup).some(name => readFileSync(join(backup, name), "utf8") === pair.service)).toBe(true);
  expect(calls.some(call => call.includes("--now") && call.includes(AUTO_UPDATE_SERVICE))).toBe(false);
  expect(await retireUpdateUnits(root, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER, "update --unattended", run)).toBe(false);
});
test("unknown unit owners are preserved before any system operation", async () => {
  const root = home(); const dir = join(root, ".config/systemd/user"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, AUTO_UPDATE_SERVICE), "my custom service");
  await expect(retireUpdateUnits(root, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER, "update --unattended", async () => { throw Error("must not call systemctl"); })).rejects.toThrow("unknown owner");
  expect(readFileSync(join(dir, AUTO_UPDATE_SERVICE), "utf8")).toBe("my custom service");
});
test("a failed retirement reload preserves evidence for the next converge", async () => {
  const root = home(); const dir = join(root, ".config/systemd/user"); mkdirSync(dir, { recursive: true });
  const pair = autoUpdateUnits("/owned/red-dev", 60);
  writeFileSync(join(dir, AUTO_UPDATE_SERVICE), pair.service); writeFileSync(join(dir, AUTO_UPDATE_TIMER), pair.timer);
  await expect(retireUpdateUnits(root, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER, "update --unattended",
    async argv => ({ exitCode: argv.includes("daemon-reload") ? 1 : 0 }))).rejects.toThrow("pending");
  expect(readFileSync(join(dir, AUTO_UPDATE_TIMER), "utf8")).toBe(pair.timer);
  expect(await retireUpdateUnits(root, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER, "update --unattended", async () => ({ exitCode: 0 }))).toBe(true);
});
test("disabling maintenance preserves unknown units and retries failed timer activation", async () => {
  const root = home(); const dir = join(root, ".config/systemd/user"); mkdirSync(dir, { recursive: true });
  const platform = { os: "linux", env: "desktop", caps: { systemd: true } } as Platform;
  writeFileSync(join(dir, WATCH_SERVICE), "my service");
  await expect(convergeWatchSchedule(platform, { home: root, env: { RED_SKILLS_WATCH: "0", RED_DEV_AUTO_UPDATE: "0" },
    run: async () => { throw Error("must not call systemctl"); } })).rejects.toThrow("unknown owner");
  expect(readFileSync(join(dir, WATCH_SERVICE), "utf8")).toBe("my service");
  rmSync(join(dir, WATCH_SERVICE));
  const calls: string[][] = []; let fail = true;
  const run = async (argv: string[]) => { calls.push(argv); return { exitCode: fail && argv.includes("enable") ? 1 : 0 }; };
  const seams = { home: root, env: {}, run };
  await expect(convergeWatchSchedule(platform, seams)).rejects.toThrow("activation failed");
  const bytes = readFileSync(join(dir, WATCH_SERVICE), "utf8");
  fail = false;
  expect(await convergeWatchSchedule(platform, seams)).toBe("unchanged");
  expect(calls.filter(argv => argv.includes("enable"))).toHaveLength(2);
  expect(readFileSync(join(dir, WATCH_SERVICE), "utf8")).toBe(bytes);
  expect(await convergeWatchSchedule(platform, { ...seams, env: { RED_SKILLS_WATCH: "0", RED_DEV_AUTO_UPDATE: "0" } })).toBe("removed");
  expect(calls.some(argv => argv.includes("--now") && argv.includes(WATCH_SERVICE))).toBe(false);
});
test("Windows task retirement requires an owned wrapper and retries failed deletion", async () => {
  const root = home(); const bin = join(root, "bin"); mkdirSync(bin);
  const wrapper = `${bin}\\red-skills-watch.cmd`;
  const old = process.env.RED_DEV_BIN_DIR; process.env.RED_DEV_BIN_DIR = bin;
  try {
    const platform = { os: "windows" } as Platform;
    const calls: string[][] = []; let fail = true;
    const xml = `<Task><Arguments>&quot;${wrapper.replaceAll("&", "&amp;")}&quot;</Arguments></Task>`;
    const seams = { env: { USERPROFILE: root, RED_SKILLS_WATCH: "0", RED_DEV_AUTO_UPDATE: "0" },
      run: async (argv: string[]) => { calls.push(argv); return { exitCode: fail && argv.includes("/Delete") ? 1 : 0, stdout: xml }; } };
    writeFileSync(wrapper, "my wrapper");
    await expect(convergeWatchSchedule(platform, seams)).rejects.toThrow("unknown owner");
    expect(calls.some(argv => argv.includes("/Delete"))).toBe(false);
    const bytes = watchWrapper("C:\\owned\\red-dev.exe"); writeFileSync(wrapper, bytes);
    await expect(convergeWatchSchedule(platform, seams)).rejects.toThrow("pending");
    expect(readFileSync(wrapper, "utf8")).toBe(bytes);
    fail = false;
    expect(await convergeWatchSchedule(platform, seams)).toBe("removed");
    const backups = join(root, ".local/state/red-dev/retired-update-triggers");
    expect(readdirSync(backups).some(name => readFileSync(join(backups, name), "utf8") === bytes)).toBe(true);
    expect(readdirSync(backups).some(name => readFileSync(join(backups, name), "utf8") === xml)).toBe(true);
  } finally {
    if (old === undefined) delete process.env.RED_DEV_BIN_DIR; else process.env.RED_DEV_BIN_DIR = old;
  }
});
test("Windows-owned WSL clocks remain owned across later local invocations; native Ubuntu stays local", () => {
  const root = home(); const wsl = { os: "linux", env: "wsl" } as Platform;
  expect(windowsOwnsMaintenance(wsl, root, {})).toBe(false);
  expect(windowsOwnsMaintenance(wsl, root, { RED_DEV_WSL_CHILD: "1" })).toBe(true);
  expect(windowsOwnsMaintenance(wsl, root, {})).toBe(true);
  expect(windowsOwnsMaintenance(wsl, root, { RED_DEV_UPDATE_OWNER: "local" })).toBe(false);
  const nativeRoot = home();
  expect(windowsOwnsMaintenance({ ...wsl, env: "desktop" }, nativeRoot, { RED_DEV_WSL_CHILD: "1" })).toBe(false);
  expect(existsSync(join(nativeRoot, ".local/state/red-dev/maintenance-owner.json"))).toBe(false);
});
