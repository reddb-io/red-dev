import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { editWslResources, machineResourcePlan, projectResourcePlan, readProjectResources } from "./resource-plan.ts";
import { applyResourceEdits, resourceEdit, resourceHistoryPath, undoResourceEdits } from "./resource-files.ts";
import { parseResourceSettings, suggestedWslMemory } from "./resource-settings.ts";
import { parseArgs, buildCli } from "./cli.ts";
import { retireWslResources } from "./resource-retirement.ts";
import type { ResourceSnapshot } from "./resource-diagnostics.ts";
import type { Platform } from "./platform.ts";

const roots: string[] = []; let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })); });
function fixture() {
  const r = mkdtempSync(join(tmpdir(), "resource-choice-")); roots.push(r);
  const env = { HOME: r, USERPROFILE: r, APPDATA: join(r, "roaming"), XDG_CONFIG_HOME: join(r, "config"), XDG_STATE_HOME: join(r, "state"), RED_DEV_PROFILE_FILE: join(r, "profile.json"), RED_DEV_POLICY_FILE: join(r, "policy.json"), RED_DEV_WSL_CHILD: "", RED_DEV_WSL_PROFILE: "" };
  const old = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  restore = () => { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  return r;
}
const ubuntu: Platform = { os: "linux", env: "desktop", arch: "x64", distro: "ubuntu", version: "24.04", codename: "noble", caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false } };
function snapshot(path: string, source: string | null): ResourceSnapshot {
  return { schema: 1, platform: "windows/windows", choice: null, buildQueue: [], linux: null, windows: { total: 32 * 1024 ** 3, available: 8 * 1024 ** 3, commitUsed: null, commitLimit: null }, wsl: { path, source, memory: "16GB", swap: "2GB", runningDistro: null }, legacy: [], unknown: [] };
}
test("the default is unrestricted and explicit resource choices reject invalid values", () => {
  expect(parseResourceSettings({ mode: "system" })).toEqual({ mode: "system" });
  expect(() => parseResourceSettings({ mode: "system", buildSlots: 1 })).toThrow();
  expect(() => parseResourceSettings({ mode: "custom", wsl: { memoryGiB: 0, swapGiB: 4 } })).toThrow();
  expect(suggestedWslMemory(32 * 1024 ** 3)).toBe(24); expect(suggestedWslMemory(null)).toBeNull();
});
test("WSL edits preserve BOM, CRLF, comments, unrelated values and sections", () => {
  const source = '\uFEFF[wsl2]\r\nmemory = 16GB # mine\r\nprocessors=8\r\nswap=2GB\r\n[experimental]\r\nnetworkingMode=mirrored\r\n';
  const result = editWslResources(source, 24, 4);
  expect(result).toBe(source.replace('16GB', '24GB').replace('swap=2GB', 'swap=4GB'));
  expect(() => editWslResources('[wsl2]\nmemory=1GB\nmemory=2GB\n', 24, 4)).toThrow("duplicate");
  expect(() => editWslResources('[wsl2]\n[wsl2]\n', 24, 4)).toThrow("duplicate");
  expect(() => editWslResources('[\0wsl2]', 24, 4)).toThrow("encoding");
});
test("explicit WSL choices cannot be retired as an old generated default", () => {
  const source = '[wsl2]\n# Added by red-dev; unrelated operator values are preserved.\nmemory=16GB\n# Added by red-dev; existing operator values are never replaced.\nswap=2GB\n';
  const result = editWslResources(source, 24, 4);
  expect(retireWslResources(result)).toBeUndefined();
});
test("a machine preview creates no profile, history or directories; saving and undo restore exact bytes", async () => {
  const r = fixture(); const path = join(r, '.wslconfig'); const source = '[wsl2]\nmemory=16GB\nswap=2GB\ncustom=true\n'; writeFileSync(path, source);
  const before = readdirSync(r);
  const plan = await machineResourcePlan({ ...ubuntu, os: "windows", env: "windows" }, { mode: "custom", wsl: { memoryGiB: 24, swapGiB: 4 } }, snapshot(path, source));
  expect(readdirSync(r)).toEqual(before); expect(plan.restartWsl).toBe(true);
  applyResourceEdits(plan.edits, plan.historyPath);
  expect(readFileSync(path, 'utf8')).toContain('memory=24GB'); expect(existsSync(process.env.RED_DEV_PROFILE_FILE!)).toBe(true);
  undoResourceEdits(plan.historyPath);
  expect(readFileSync(path, 'utf8')).toBe(source); expect(existsSync(process.env.RED_DEV_PROFILE_FILE!)).toBe(false);
});
test("system choice restores the original WSL budget after repeated explicit changes", async () => {
  const r = fixture(); const path = join(r, '.wslconfig'); const source = '[wsl2]\nmemory=16GB\nswap=2GB\n'; writeFileSync(path, source);
  const windows = { ...ubuntu, os: "windows", env: "windows" } as Platform;
  for (const memory of [24, 20]) {
    const plan = await machineResourcePlan(windows, { mode: "custom", wsl: { memoryGiB: memory, swapGiB: 4 } }, snapshot(path, readFileSync(path, 'utf8')));
    applyResourceEdits(plan.edits, plan.historyPath);
  }
  const system = await machineResourcePlan(windows, { mode: "system" }, snapshot(path, readFileSync(path, 'utf8')));
  applyResourceEdits(system.edits, system.historyPath); expect(readFileSync(path, 'utf8')).toBe(source);
});
test("preview races and later edits are preserved; undo checks every file before writing any", () => {
  const r = fixture(); const a = join(r, 'a'), b = join(r, 'b'); writeFileSync(a, 'original'); writeFileSync(b, 'original');
  const edits = [resourceEdit(a, 'chosen'), resourceEdit(b, 'chosen')]; const history = resourceHistoryPath();
  writeFileSync(a, 'external'); expect(() => applyResourceEdits(edits, history)).toThrow('changed since preview');
  expect(existsSync(history)).toBe(false); writeFileSync(a, 'original'); applyResourceEdits(edits, history);
  writeFileSync(b, 'external'); expect(() => undoResourceEdits(history)).toThrow('another owner');
  expect(readFileSync(a, 'utf8')).toBe('chosen'); expect(readFileSync(b, 'utf8')).toBe('external');
});
test("an interrupted multi-file restoration can retry, including a dead owned file lock", () => {
  const r = fixture(); const a = join(r, 'a'), b = join(r, 'b'); writeFileSync(a, 'original'); writeFileSync(b, 'original');
  const history = resourceHistoryPath(); applyResourceEdits([resourceEdit(a, 'chosen'), resourceEdit(b, 'chosen')], history);
  const value = JSON.parse(readFileSync(history, 'utf8')); value.transactions[0].state = 'pending'; writeFileSync(history, JSON.stringify(value)); writeFileSync(a, 'original');
  writeFileSync(b + '.red-dev-resources.lock', JSON.stringify({ pid: 2147483647, host: hostname(), platform: process.platform, distro: process.env.WSL_DISTRO_NAME ?? null }));
  undoResourceEdits(history); expect(readFileSync(a, 'utf8')).toBe('original'); expect(readFileSync(b, 'utf8')).toBe('original');
});
test("Rust configuration stays project scoped, preserves unknown owners and changes no Cargo files", () => {
  const r = fixture(); writeFileSync(join(r, 'Cargo.toml'), '[package]\nname="fixture"\n');
  const plan = projectResourcePlan(r, 4); expect(existsSync(join(r, '.red-dev'))).toBe(false);
  applyResourceEdits(plan.edits, plan.historyPath); expect(readProjectResources(r)?.jobs).toBe(4);
  expect(existsSync(join(r, '.cargo/config.toml'))).toBe(false);
  undoResourceEdits(plan.historyPath); expect(readProjectResources(r)).toBeNull();
  writeFileSync(join(r, '.red-dev/resources.json'), '{"schema":2,"jobs":8}');
  expect(() => projectResourcePlan(r, 4)).toThrow('preserved');
});
test("resource parsing validates bounds and forwards literal Cargo arguments", () => {
  const cli = buildCli(); const parsed = parseArgs(cli, ['resources', 'run', '--project', '/my project', '--', 'cargo', 'test', '--', '--test-threads=2']);
  expect(parsed.errors).toEqual([]); expect(parsed.resourceProject).toBe('/my project');
  expect(parsed.passthrough).toEqual(['cargo', 'test', '--', '--test-threads=2']);
  expect(parseArgs(cli, ['resources', 'configure', 'custom', '--memory', '0', '--apply']).errors.length).toBeGreaterThan(0);
  expect(parseArgs(cli, ['resources', 'status', '--apply']).errors.length).toBeGreaterThan(0);
});
test("actual resource status and preview commands leave desired config and state untouched", async () => {
  const r = fixture(); const name = process.platform === 'win32' ? 'windows-native' : 'ubuntu-desktop';
  // Windows initializes this standard user folder when PowerShell/CIM starts.
  // Real Windows profiles already have it; seed it before checking product writes.
  if (process.platform === 'win32') mkdirSync(join(r, 'AppData/Roaming'), { recursive: true });
  writeFileSync(process.env.RED_DEV_PROFILE_FILE!, JSON.stringify({ schema: 1, name, tools: {} }));
  const before = readdirSync(r, { recursive: true }); const bytes = readFileSync(process.env.RED_DEV_PROFILE_FILE!, 'utf8');
  for (const args of [['resources', 'status', '--json'], ['resources', 'configure', 'custom', '--slots', '1']]) {
    const child = Bun.spawn([process.execPath, fileURLToPath(new URL('./main.ts', import.meta.url)), ...args], { env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, stdout: 'pipe', stderr: 'pipe' });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect([code, err]).toEqual([0, '']);
    if (args.includes('--json')) { expect(JSON.parse(out).schema).toBe(1); expect(JSON.parse(out).wsl.source).toBeUndefined(); }
    else expect(out).toContain('Preview only');
  }
  expect(readdirSync(r, { recursive: true })).toEqual(before); expect(readFileSync(process.env.RED_DEV_PROFILE_FILE!, 'utf8')).toBe(bytes);
}, 30000);
