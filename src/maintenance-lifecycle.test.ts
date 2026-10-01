import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { retireUpdateUnits } from "./retire-update-schedule.ts";
import { windowsOwnsMaintenance } from "./maintenance-owner.ts";
import { autoUpdateUnits, AUTO_UPDATE_SERVICE, AUTO_UPDATE_TIMER } from "./auto-update-schedule.ts";
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
