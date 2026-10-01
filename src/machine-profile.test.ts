import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMachineProfile, writeMachineProfile, profilePath, type MachineProfile } from "./machine-profile.ts";
import { adoptMachineProfile, resolveMachineProfile, profileCommand } from "./profile-command.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { configDir } from "./alacritty.ts";
import { providerFor, TOOLS, applicableScopes, type Tool } from "./manifest.ts";
import { miseEntries, miseToolNames } from "./mise-config.ts";
import { toolPolicy } from "./tool-policy.ts";
import { planTool, planLine, provisionPlan } from "./provision-plan.ts";
import { converge } from "./converge.ts";
import { wslChildEnvironment } from "./wsl-sync.ts";
import { parseArgs, buildCli } from "./cli.ts";
import { profileAgentPlan } from "./profile-agents.ts";
import { profileRuntimePlan } from "./runtimes.ts";
import { profileRetirementLines } from "./profile-retirements.ts";
import { fileURLToPath } from "node:url";
import type { Platform } from "./platform.ts";

const ubuntu: Platform = { os: "linux", env: "desktop", distro: "ubuntu", version: "26.04", codename: "resolute", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false } };
const windows: Platform = { ...ubuntu, os: "windows", env: "windows", distro: null, version: null, workstation: "windows-wsl",
  caps: { ...ubuntu.caps, apt: false, systemd: false, winget: true } };
const roots: string[] = []; let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "red-profile-")); roots.push(root);
  const env = { HOME: root, USERPROFILE: root, APPDATA: join(root, "roaming"), LOCALAPPDATA: join(root, "local"), XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"), MISE_CONFIG_DIR: join(root, "mise"), MISE_CONFIG_FILE: join(root, "mise.toml"),
    RED_DEV_PROFILE_FILE: join(root, "profile.json"), RED_DEV_POLICY_FILE: join(root, "policies.json"), RED_DEV_WSL_CHILD: "", RED_DEV_WSL_PROFILE: "" };
  const before = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]])); Object.assign(process.env, env);
  restore = () => { for (const [key, value] of Object.entries(before)) if (value === undefined) delete process.env[key]; else process.env[key] = value; };
  return root;
}
const profile = (over: Partial<MachineProfile> = {}): MachineProfile => ({ schema: 1, name: "ubuntu-desktop", tools: {}, ...over });
const tool = (name: string): Tool => TOOLS.find(t => t.name === name)!;

test("fresh plan infers a profile and writes no desired configuration", async () => {
  const root = fixture();
  expect((await resolveMachineProfile(ubuntu)).name).toBe("ubuntu-desktop");
  expect(existsSync(profilePath())).toBe(false);
  expect(readdirSync(root)).toEqual([]);
});
test("adoption preserves legacy preference bytes, selectors and optional choices", async () => {
  fixture(); const dir = await configDir(ubuntu); mkdirSync(dir, { recursive: true });
  const path = join(dir, "red-dev.json");
  const legacy = '{"agents":["opencode","gemini","codex"],"runtimes":["node@lts"],"apps":["antigravity"],"fontSize":13,"custom":"preserve"}\n';
  writeFileSync(path, legacy); writeFileSync(process.env.MISE_CONFIG_FILE!, '[tools]\nnode = "lts"\n');
  const p = { ...ubuntu };
  await adoptMachineProfile(p);
  expect(readMachineProfile()?.agents).toEqual(["redcode", "codex"]);
  expect(readMachineProfile()?.runtimes).toEqual(["node@lts"]);
  expect(readFileSync(path, "utf8")).toBe(legacy);
  expect(toolPolicy("node")).toEqual({ mode: "fixed", version: "lts" });
  expect(applicableScopes(p)).toContain("optional");
  const bytes = readFileSync(profilePath(), "utf8"); await adoptMachineProfile(p);
  expect(readFileSync(profilePath(), "utf8")).toBe(bytes);
});
test("invalid preference/profile input is reported without overwriting or adopting defaults", async () => {
  fixture(); const dir = await configDir(ubuntu); mkdirSync(dir, { recursive: true });
  const path = join(dir, "red-dev.json"); writeFileSync(path, "broken preferences");
  await expect(adoptMachineProfile({ ...ubuntu })).rejects.toThrow();
  expect(existsSync(profilePath())).toBe(false);
  expect(readFileSync(path, "utf8")).toBe("broken preferences");
  writeFileSync(profilePath(), "unknown profile owner");
  expect(() => writeMachineProfile(profile())).toThrow();
  expect(readFileSync(profilePath(), "utf8")).toBe("unknown profile owner");
});
test("profile editing refuses unsupported platforms, unknown tools and disabling lifecycle protection", async () => {
  fixture();
  await expect(profileCommand(ubuntu, "use", "windows-native")).rejects.toThrow("incompatible");
  await expect(profileCommand(ubuntu, "disable", "invented-tool")).rejects.toThrow("unknown");
  await expect(profileCommand(ubuntu, "disable", "retired-resource-controls")).rejects.toThrow("required");
  expect(existsSync(profilePath())).toBe(false);
});
test("a deselected tool is excluded from installs/upgrades without removing its bytes or personal declarations", async () => {
  const root = fixture(); const binary = join(root, "my-router"); writeFileSync(binary, "my installation");
  writeFileSync(process.env.MISE_CONFIG_FILE!, '[tools]\nred-router = "0.13.0"\n');
  await profileCommand({ ...ubuntu }, "disable", "red-router");
  const p = { ...ubuntu, profile: readMachineProfile()! };
  expect(providerFor(tool("red-router"), p).kind).toBe("skip");
  expect(providerFor(tool("red-router-autostart"), p).kind).toBe("skip");
  expect(miseToolNames(p)).not.toContain("red-router");
  expect(readFileSync(binary, "utf8")).toBe("my installation");
  expect(readFileSync(process.env.MISE_CONFIG_FILE!, "utf8")).toContain('"0.13.0"');
  expect(planLine(planTool(tool("red-router"), p))).toContain("preserve installed package");
});
test("profile preferences remain one selection through old agents/lang/apps commands", async () => {
  fixture(); writeMachineProfile(profile({ agents: ["codex"], runtimes: ["node@lts"], apps: [] }));
  await writePreferences(ubuntu, { agents: ["claude-code"], runtimes: ["rust@latest"], apps: ["antigravity"] });
  expect(readMachineProfile()?.agents).toEqual(["claude-code"]);
  expect((await readPreferences(ubuntu)).runtimes).toEqual(["rust@latest"]);
  expect(readMachineProfile()?.tools.antigravity).toBe(true);
  expect(readMachineProfile()?.tools.puppeteer).toBe(false);
  expect(providerFor(tool("puppeteer"), { ...ubuntu, profile: readMachineProfile()! }).kind).toBe("skip");
});
test("Windows forwards desired choices separately from credentials, and child adoption preserves local overrides", async () => {
  fixture(); writeMachineProfile(profile({ name: "windows-wsl", tools: { "red-router": false }, agents: ["redcode"], distro: "Ubuntu-26.04" }));
  const env = wslChildEnvironment(process.env, "fixture-token");
  expect(env.WSLENV).toContain("RED_DEV_WSL_PROFILE");
  expect(env.RED_DEV_WSL_PROFILE).not.toContain("fixture-token");
  writeMachineProfile(profile({ name: "ubuntu-wsl", tools: { docker: false } }));
  process.env.RED_DEV_WSL_CHILD = "1"; process.env.RED_DEV_WSL_PROFILE = env.RED_DEV_WSL_PROFILE;
  const wsl = { ...ubuntu, env: "wsl" } as Platform;
  const desired = await resolveMachineProfile(wsl);
  expect(desired.tools).toEqual({ docker: false, "red-router": false });
  expect(readMachineProfile()?.tools["red-router"]).toBeUndefined(); // plan is read-only
  await adoptMachineProfile(wsl);
  expect(readMachineProfile()?.name).toBe("ubuntu-wsl");
  expect(readMachineProfile()?.agents).toEqual(["redcode"]);
});
test("Windows-native profile records the terminal choice without forcing WSL", async () => {
  fixture(); await profileCommand({ ...windows }, "use", "windows-native");
  expect((await readPreferences(windows)).terminalShell).toBe("gitbash");
  expect(readMachineProfile()?.name).toBe("windows-native");
});
test("Windows/WSL plan distinguishes host ownership and unobserved remote tools without probing the Linux host", () => {
  fixture(); const host = { ...windows, profile: profile({ name: "windows-wsl" }) };
  expect(planTool(tool("alacritty"), host, { state: () => "ok" }).target).toBe("Windows");
  expect(planTool(tool("red-router"), host).action).toBe("skip");
  const remote = { ...ubuntu, env: "wsl", profile: profile({ name: "ubuntu-wsl" }) } as Platform;
  const step = planTool(tool("red-router"), remote, { observed: false, state: () => { throw Error("must not probe local installation"); } });
  expect(step.target).toBe("Ubuntu/WSL");
  expect(planLine(step)).toContain("installation not observed");
});
test("the installation reports the same providers and exclusions as the reviewed plan", async () => {
  fixture(); const p = { ...ubuntu, profile: profile({ tools: { docker: false, "red-router": false } }) };
  const plan = provisionPlan(p, ["core"]);
  const result = await converge({ platform: p, ctx: { platform: p, theme: "ember", font: "firacode", opacity: 90 }, scopes: ["core"], dryRun: true });
  for (const name of ["docker", "red-router", "red-router-autostart"]) {
    const step = plan.find(s => s.tool.name === name)!;
    const applied = result.results.find(s => s.tool === name)!;
    expect(applied.outcome).toBe("skipped");
    expect(applied.detail).toBe(step.reason);
  }
});
test("agent selections keep unchosen publishers outside the generated managed inventory", async () => {
  fixture(); const p = { ...ubuntu, profile: profile({ agents: ["codex"] }) };
  expect(miseEntries(p).some(e => e.alias === "redcode")).toBe(false);
  const planned = await profileAgentPlan(p, async () => false);
  expect(planned.map(s => s.agent.key)).toEqual(["codex"]);
  expect(planned[0]?.action).toBe("install");
});
test("public parser carries the profile action and tool without interpreting them as scopes", () => {
  const parsed = parseArgs(buildCli(), ["profile", "disable", "docker"]);
  expect(parsed.errors).toEqual([]);
  expect([parsed.profileAction, parsed.profileValue]).toEqual(["disable", "docker"]);
});
test("selected npm packages declare their runtime dependency, while Windows delegates that dependency to WSL", async () => {
  fixture();
  const p = { ...ubuntu, profile: profile({ runtimes: [] }) };
  expect(await profileRuntimePlan(p)).toContainEqual({ id: "node@latest", reason: "required by a selected package/agent" });
  expect(await profileRuntimePlan({ ...windows, profile: profile({ name: "windows-wsl", runtimes: [] }) })).toEqual([]);
});
test("the actual plan CLI is read-only and reports desired actions", async () => {
  const root = fixture();
  const name = process.platform === "win32" ? "windows-native" : "ubuntu-desktop";
  writeMachineProfile(profile({ name, tools: { docker: false }, agents: [], runtimes: [] }));
  const before = readdirSync(root); const bytes = readFileSync(profilePath(), "utf8");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./main.ts", import.meta.url)), "plan", "core"], {
    env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect([code, stderr]).toEqual([0, ""]);
  expect(stdout).toContain("unmanage"); expect(stdout).toContain(`[profile: ${name}]`);
  expect(readdirSync(root, { recursive: true })).toEqual(before);
  expect(readFileSync(profilePath(), "utf8")).toBe(bytes);
});
test("the plan names only owned legacy defaults for retirement and leaves exact bytes intact", () => {
  const root = fixture(); const dir = join(root, ".config/red-dev"); mkdirSync(dir, { recursive: true });
  const path = join(dir, "cargo.toml"); const owned = "# Managed by red-dev.\n[build]\njobs=2\n"; writeFileSync(path, owned);
  expect(profileRetirementLines(ubuntu, root).some(line => line.includes("retire owned default") && line.includes(path))).toBe(true);
  expect(readFileSync(path, "utf8")).toBe(owned);
  writeFileSync(path, "[build]\njobs=4\n");
  const lines = profileRetirementLines(ubuntu, root);
  expect(lines.some(line => line.includes("preserve unknown owner") && line.includes(path))).toBe(true);
  expect(lines.some(line => line.includes("retire owned default") && line.includes(path))).toBe(false);
});
test("a fixed version takes precedence over a catalog minimum without executing its binary", () => {
  const root = fixture();
  const dir = join(root, "installs/neovim/0.10.0/bin"); mkdirSync(dir, { recursive: true });
  const binary = join(dir, "nvim"); writeFileSync(binary, "not executable");
  writeFileSync(process.env.MISE_CONFIG_FILE!, '[tools]\nneovim="0.10.0"\n');
  const step = planTool({ ...tool("neovim"), cmd: [binary] }, ubuntu);
  expect(step.policy).toEqual({ mode: "fixed", version: "0.10.0" });
  expect(step.action).toBe("keep");
  expect(step.foundVersion).toBe("0.10.0");
});
