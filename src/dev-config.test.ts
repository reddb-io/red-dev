import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { devConfigPath, legacyPolicyPath, legacyProfilePath, readDevConfig, writeDevConfig } from "./dev-config.ts";
import { forgetWindowsDirs, windowsEnvRecord } from "./windows-env.ts";
import { redDevStateRoot } from "./reclaim.ts";
import { childPreferences, migrateDevConfig } from "./dev-config-migration.ts";
import { legacyPreferencesPath, readPreferences, writePreferences } from "./preferences.ts";
import { readMachineProfile, writeMachineProfile, type MachineProfile } from "./machine-profile.ts";
import { writeToolPolicy, toolPolicy, userMisePath } from "./tool-policy.ts";
import { wslChildEnvironment } from "./wsl-sync.ts";
import { acquireUpdateLock } from "./update-coordinator.ts";
import { applyResourceEdits, readResourceHistory, resourceEdit, resourceHistoryPath, undoResourceEdits } from "./resource-files.ts";
import { removeConfiguration } from "./uninstall.ts";
import type { Platform } from "./platform.ts";

const p: Platform = { os: process.platform === "win32" ? "windows" : "linux", env: process.platform === "win32" ? "windows" : "desktop",
  distro: "ubuntu", version: "26.04", codename: null, arch: "x64", caps: { gui: false, systemd: false, winget: false, apt: false, flatpak: false } };
const profile: MachineProfile = { schema: 1, name: "ubuntu-desktop", tools: {}, agents: ["codex"], resources: { mode: "custom", buildSlots: 1 } };
let restore: (() => void) | undefined;
const roots: string[] = [];
afterEach(() => { restore?.(); restore = undefined; for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "red-dev-yaml-")); roots.push(root);
  const env = { HOME: root, USERPROFILE: root, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"), MISE_CONFIG_DIR: "", MISE_CONFIG_FILE: "",
    RED_DEV_CONFIG_FILE: "", RED_DEV_PROFILE_FILE: "", RED_DEV_POLICY_FILE: "", RED_DEV_WSL_CHILD: "", RED_DEV_WSL_PROFILE: "", RED_DEV_WSL_PREFERENCES: "" };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  restore = () => { for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  return root;
}
function put(path: string, source: string | Buffer) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source); }
function backup(path: string, source: string | Buffer) { return `${path}.red-dev-config-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.bak`; }

test("default YAML holds profile, preferences and policies; reads do not create directories", async () => {
  const root = fixture(); const before = readdirSync(root);
  expect(readDevConfig()).toBeNull(); expect(readMachineProfile()).toBeNull(); expect(await readPreferences(p)).toEqual({});
  expect(readdirSync(root)).toEqual(before);
  expect(devConfigPath()).toBe(join(root, ".red", "dev", "config.yaml"));
  writeMachineProfile(profile); await writePreferences(p, { theme: "dark", defaultAgent: "codex" }); writeToolPolicy("node", { mode: "fixed", version: "22.1.0" });
  expect(readDevConfig()).toMatchObject({ profile, preferences: { theme: "dark", defaultAgent: "codex" }, policies: { node: { mode: "fixed", version: "22.1.0" } } });
  expect(readMachineProfile()?.resources?.buildSlots).toBe(1); expect(toolPolicy("node")).toEqual({ mode: "fixed", version: "22.1.0" });
  expect(userMisePath()).toBe(join(process.env.XDG_CONFIG_HOME!, "mise", "config.toml"));
  if (process.platform !== "win32") expect(statSync(devConfigPath()).mode & 0o777).toBe(0o600);
});

test("legacy migration preserves exact CRLF/BOM bytes and unknown choices and is idempotent", async () => {
  fixture(); const preferences = await legacyPreferencesPath(p);
  const prefBytes = '\uFEFF{ "theme": "cobalt", "fontSize": 13, "custom": {"keep":true} }\r\n';
  const profileBytes = JSON.stringify(profile) + "\r\n"; const policyBytes = '{"node":{"mode":"follow"}}\r\n';
  for (const [path, bytes] of [[preferences, prefBytes], [legacyProfilePath(), profileBytes], [legacyPolicyPath(), policyBytes]]) put(path!, bytes!);
  await migrateDevConfig(p);
  for (const [path, bytes] of [[preferences, prefBytes], [legacyProfilePath(), profileBytes], [legacyPolicyPath(), policyBytes]]) {
    expect(existsSync(path!)).toBe(false); expect(readFileSync(backup(path!, bytes!), "utf8")).toBe(bytes!);
  }
  expect(readDevConfig()).toMatchObject({ profile, preferences: { theme: "cobalt", fontSize: 13, custom: { keep: true } }, policies: { node: { mode: "follow" } } });
  const first = readFileSync(devConfigPath(), "utf8"); const journal = join(redDevStateRoot(), "config-migration.json");
  const history = readFileSync(journal, "utf8"); await migrateDevConfig(p);
  expect(readFileSync(devConfigPath(), "utf8")).toBe(first); expect(readFileSync(journal, "utf8")).toBe(history);
});

test("editing one section preserves comments, unknown fields, file mode and authoritative YAML", async () => {
  fixture(); const source = '# My workstation\nschema: 1\npreferences:\n  theme: dark # keep this comment\n  custom: yes\nfuture:\n  mode: keep\n'; put(devConfigPath(), source);
  if (process.platform !== "win32") chmodSync(devConfigPath(), 0o640);
  await writePreferences(p, { defaultAgent: "codex" }); writeMachineProfile(profile); writeToolPolicy("node", { mode: "follow" });
  const after = readFileSync(devConfigPath(), "utf8"); expect(after).toContain("# My workstation"); expect(after).toContain("theme: dark # keep this comment");
  expect(readDevConfig()).toMatchObject({ future: { mode: "keep" }, preferences: { custom: "yes", defaultAgent: "codex" } });
  if (process.platform !== "win32") expect(statSync(devConfigPath()).mode & 0o777).toBe(0o640);
  await writePreferences(p, { theme: "cobalt" });
  expect(readFileSync(devConfigPath(), "utf8")).toContain("theme: cobalt # keep this comment");
  writeDevConfig(config => ({ ...config, policies: { node: { mode: "fixed", version: "22.1.0", note: "preserve" } } }));
  writeToolPolicy("node", { mode: "follow" });
  expect(readDevConfig()?.policies?.node).toEqual({ mode: "follow", note: "preserve" });
  put(await legacyPreferencesPath(p), '{"theme":"cobalt"}'); await migrateDevConfig(p);
  expect((await readPreferences(p)).theme).toBe("cobalt");
});

test("invalid YAML, duplicate keys, unsupported schemas and corrupt nested sections never select defaults or get overwritten", async () => {
  fixture();
  for (const source of ['schema: 2\n', 'schema: 1\nschema: 1\n', 'schema: 1\npreferences: []\n', 'schema: 1\nprofile: {schema: 9}\n', 'schema: 1\npolicies: {node: {mode: unknown}}\n', 'schema: 1\npreferences: [\n']) {
    put(devConfigPath(), source);
    expect(() => writeToolPolicy("node", { mode: "follow" })).toThrow(); await expect(readPreferences(p)).rejects.toThrow();
    await expect(migrateDevConfig(p)).rejects.toThrow(); expect(readFileSync(devConfigPath(), "utf8")).toBe(source);
  }
});

test("invalid legacy sources, backup conflicts and unknown-only preferences remain intact", async () => {
  fixture(); const path = await legacyPreferencesPath(p); put(path, '{"theme":"dark"}'); put(backup(path, '{"theme":"dark"}'), "foreign backup");
  await expect(migrateDevConfig(p)).rejects.toThrow("another owner"); expect(readFileSync(path, "utf8")).toBe('{"theme":"dark"}'); expect(existsSync(devConfigPath())).toBe(false);
  rmSync(backup(path, '{"theme":"dark"}')); put(path, '{"customOnly":true}'); await migrateDevConfig(p);
  expect(readFileSync(path, "utf8")).toBe('{"customOnly":true}'); expect(readDevConfig()?.preferences?.customOnly).toBe(true);
  put(path, Buffer.from([123, 34, 120, 34, 58, 34, 255, 34, 125])); await expect(migrateDevConfig(p)).rejects.toThrow(); expect(readFileSync(path)[6]).toBe(255);
});

test.skipIf(process.platform === "win32")("symlink sources are imported without retirement; canonical symlinks are never replaced", async () => {
  const root = fixture(); const source = join(root, "my-profile.json"); put(source, JSON.stringify(profile)); mkdirSync(dirname(legacyProfilePath()), { recursive: true }); symlinkSync(source, legacyProfilePath());
  await migrateDevConfig(p); expect(readMachineProfile()).toEqual(profile); expect(existsSync(legacyProfilePath())).toBe(true);
  const yaml = readFileSync(devConfigPath(), "utf8"); rmSync(devConfigPath()); const target = join(root, "my-config.yaml"); put(target, yaml); symlinkSync(target, devConfigPath());
  expect(() => writeMachineProfile(profile)).toThrow("regular file"); await expect(migrateDevConfig(p)).rejects.toThrow("regular file"); expect(readFileSync(target, "utf8")).toBe(yaml);
  rmSync(target); expect(() => writeMachineProfile(profile)).toThrow("regular file"); expect(existsSync(target)).toBe(false);
});

test("explicit JSON overrides stay separate while all other sections use YAML", async () => {
  const root = fixture(); process.env.RED_DEV_CONFIG_FILE = join(root, "choices.yaml"); process.env.RED_DEV_PROFILE_FILE = join(root, "profile.json"); process.env.RED_DEV_POLICY_FILE = join(root, "policy.json");
  writeMachineProfile(profile); writeToolPolicy("node", { mode: "external" }); await writePreferences(p, { theme: "dark", agents: ["redcode"] });
  expect(readMachineProfile()?.agents).toEqual(["redcode"]); expect(toolPolicy("node")).toEqual({ mode: "external" }); expect(readDevConfig()?.profile).toBeUndefined(); expect(readDevConfig()?.policies).toBeUndefined();
  expect(existsSync(process.env.RED_DEV_PROFILE_FILE)).toBe(true); expect(existsSync(process.env.RED_DEV_POLICY_FILE)).toBe(true);
});

test("Windows forwarding includes chosen fields and excludes private/unknown fields and Windows override paths", async () => {
  fixture(); writeMachineProfile({ ...profile, name: "windows-wsl" });
  writeDevConfig(config => ({ ...config, preferences: { theme: "cobalt", defaultAgent: "codex", fontSize: 13, crashHandoff: false, custom: "private", sshGithubUser: "host-only" } }));
  const env = wslChildEnvironment({ ...process.env, WSLENV: "RED_DEV_CONFIG_FILE/p:CUSTOM/p" }, "fixture-secret");
  expect(JSON.parse(env.RED_DEV_WSL_PREFERENCES!)).toEqual({ theme: "cobalt", defaultAgent: "codex", fontSize: 13 }); expect(env.WSLENV).not.toContain("RED_DEV_CONFIG_FILE");
  process.env.RED_DEV_WSL_CHILD = "1"; process.env.RED_DEV_WSL_PREFERENCES = env.RED_DEV_WSL_PREFERENCES;
  writeDevConfig(config => ({ ...config, preferences: { theme: "dark", wallpaper: "flare" } })); await migrateDevConfig(p);
  expect(readDevConfig()?.preferences).toEqual({ theme: "cobalt", wallpaper: "flare", defaultAgent: "codex", fontSize: 13 });
  process.env.RED_DEV_WSL_CHILD = ""; expect(childPreferences()).toEqual({});
});

test("configuration writers and resource edits share an exclusion; blocked edits change no bytes", () => {
  fixture(); writeMachineProfile(profile); const source = readFileSync(devConfigPath(), "utf8"); const release = acquireUpdateLock(`${devConfigPath()}.writer`)!;
  try {
    expect(() => writeToolPolicy("node", { mode: "follow" })).toThrow("being edited");
    expect(() => applyResourceEdits([resourceEdit(devConfigPath(), "schema: 1\n")], resourceHistoryPath())).toThrow("being edited");
    expect(readFileSync(devConfigPath(), "utf8")).toBe(source);
  } finally { release(); }
  writeToolPolicy("node", { mode: "follow" }); expect(toolPolicy("node")).toEqual({ mode: "follow" });
});

test("resource undo keeps later theme, agents, policy and comments and refuses changed resource choices", async () => {
  fixture(); writeMachineProfile({ ...profile, resources: undefined });
  const original = readFileSync(devConfigPath(), "utf8"); writeMachineProfile(profile); const after = readFileSync(devConfigPath(), "utf8"); put(devConfigPath(), original);
  applyResourceEdits([{ ...resourceEdit(devConfigPath(), after), section: "resources" }], resourceHistoryPath());
  await writePreferences(p, { theme: "cobalt", agents: ["redcode"] }); writeToolPolicy("node", { mode: "external" });
  put(devConfigPath(), "# My choices\n" + readFileSync(devConfigPath(), "utf8")); undoResourceEdits(resourceHistoryPath());
  expect(readMachineProfile()?.resources).toBeUndefined(); expect(readMachineProfile()?.agents).toEqual(["redcode"]); expect(readDevConfig()?.preferences?.theme).toBe("cobalt"); expect(toolPolicy("node")).toEqual({ mode: "external" }); expect(readFileSync(devConfigPath(), "utf8")).toContain("# My choices");
  const before = readFileSync(devConfigPath(), "utf8"); writeMachineProfile(profile); const next = readFileSync(devConfigPath(), "utf8"); put(devConfigPath(), before);
  applyResourceEdits([{ ...resourceEdit(devConfigPath(), next), section: "resources" }], resourceHistoryPath());
  writeMachineProfile({ ...profile, resources: { mode: "custom", buildSlots: 3 } }); const foreign = readFileSync(devConfigPath(), "utf8");
  expect(() => undoResourceEdits(resourceHistoryPath())).toThrow("another owner"); expect(readFileSync(devConfigPath(), "utf8")).toBe(foreign);
});

test("legacy resource history migrates and its undo keeps subsequent YAML edits", async () => {
  fixture(); const old = legacyProfilePath(); put(old, JSON.stringify({ ...profile, resources: undefined }));
  applyResourceEdits([resourceEdit(old, JSON.stringify(profile))], resourceHistoryPath()); await migrateDevConfig(p);
  expect(readResourceHistory(resourceHistoryPath()).transactions[0]?.edits[0]).toMatchObject({ path: devConfigPath(), section: "resources" });
  await writePreferences(p, { theme: "cobalt" }); undoResourceEdits(resourceHistoryPath());
  expect(readMachineProfile()?.resources).toBeUndefined(); expect(readDevConfig()?.preferences?.theme).toBe("cobalt");
});

test("an interrupted configuration migration restores exact sources then retries", async () => {
  fixture(); const path = await legacyPreferencesPath(p); const bytes = '{"theme":"cobalt"}\r\n'; put(path, bytes);
  const journal = join(redDevStateRoot(), "config-migration.json");
  const edits = [resourceEdit(devConfigPath(), 'schema: 1\npreferences: {theme: cobalt}\n'), resourceEdit(backup(path, bytes), bytes), resourceEdit(path, null)];
  put(journal, JSON.stringify({ schema: 1, transactions: [{ id: "interrupted", state: "pending", edits }] }));
  put(devConfigPath(), 'schema: 1\npreferences: {theme: cobalt}\n'); // crash before backup/removal
  await migrateDevConfig(p); expect(readDevConfig()?.preferences?.theme).toBe("cobalt"); expect(readFileSync(backup(path, bytes), "utf8")).toBe(bytes); expect(existsSync(path)).toBe(false);
});

test("interrupted legacy resource transactions block configuration migration without changing files", async () => {
  fixture(); const old = legacyProfilePath(); const bytes = JSON.stringify(profile); put(old, bytes);
  put(resourceHistoryPath(), JSON.stringify({ schema: 1, transactions: [{ id: "interrupted", state: "pending", edits: [resourceEdit(old, null)] }] }));
  await expect(migrateDevConfig(p)).rejects.toThrow("interrupted resource"); expect(readFileSync(old, "utf8")).toBe(bytes); expect(existsSync(devConfigPath())).toBe(false);
});

test.skipIf(process.platform === "win32")("actual config command reads both legacy and YAML choices without creating state", async () => {
  const root = fixture(); const legacy = await legacyPreferencesPath(p); put(legacy, '{"defaultAgent":"codex"}');
  const run = async () => {
    const child = Bun.spawn([process.execPath, "src/main.ts", "config", "--json"], { stdout: "pipe", stderr: "pipe", env: { ...process.env, PATH: "", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); expect([code, err]).toEqual([0, ""]); return JSON.parse(out);
  };
  const before = readdirSync(root, { recursive: true }); expect((await run()).preferences.defaultAgent).toBe("codex"); expect(readdirSync(root, { recursive: true })).toEqual(before);
  await migrateDevConfig(p); writeMachineProfile(profile); const files = readdirSync(root, { recursive: true }); const bytes = readFileSync(devConfigPath(), "utf8"); expect((await run()).profile).toEqual(profile); expect(readdirSync(root, { recursive: true })).toEqual(files); expect(readFileSync(devConfigPath(), "utf8")).toBe(bytes);
});

test.skipIf(process.platform === "win32")("uninstall preserves all saved choices and other ~/.red data", async () => {
  const root = fixture(); writeMachineProfile(profile); await writePreferences(p, { theme: "cobalt" }); writeToolPolicy("node", { mode: "external" });
  put(join(root, ".red", "my-data"), "user data"); const bytes = readFileSync(devConfigPath(), "utf8");
  const previousPath = process.env.PATH; process.env.PATH = "";
  try { await removeConfiguration(p); } finally { process.env.PATH = previousPath; }
  expect(readFileSync(devConfigPath(), "utf8")).toBe(bytes); expect(readFileSync(join(root, ".red", "my-data"), "utf8")).toBe("user data");
});


test("WSL imports host legacy preferences but preserves its source, and subsequent YAML reads need no interop", async () => {
  const root = fixture(); const host = process.platform === "win32" ? process.env.APPDATA! : join(root, "windows-host");
  mkdirSync(host, { recursive: true }); put(join(root, ".cache", "red-dev", "windows-env"), windowsEnvRecord({ APPDATA: host })); forgetWindowsDirs();
  const shared = join(host, "alacritty", "red-dev.json"); const bytes = '{"theme":"dark","fontSize":14,"custom":"host-choice"}\r\n'; put(shared, bytes);
  const wsl = { ...p, os: "linux", env: "wsl" } as Platform;
  await migrateDevConfig(wsl); expect(readDevConfig()?.preferences).toMatchObject({ theme: "dark", fontSize: 14, custom: "host-choice" });
  expect(readFileSync(shared, "utf8")).toBe(bytes); expect(existsSync(backup(shared, bytes))).toBe(false);
  rmSync(join(root, ".cache"), { recursive: true, force: true }); rmSync(host, { recursive: true, force: true }); forgetWindowsDirs();
  await migrateDevConfig(wsl); expect((await readPreferences(wsl)).fontSize).toBe(14);
});
