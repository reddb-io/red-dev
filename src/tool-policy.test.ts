import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installSelector, policyPath, toolPolicy, writeToolPolicy } from "./tool-policy.ts";
import { providerFor, TOOLS } from "./manifest.ts";
import { miseEntries, miseToolNames, miseToolSpecs } from "./mise-config.ts";
import { AGENTS } from "./agents.ts";
import { planAgentUpdate } from "./agent-update.ts";
import { updateRedDev } from "./self-update.ts";
import { parseArgs, buildCli } from "./cli.ts";
import { policyCommand } from "./policy-command.ts";
import type { Platform } from "./platform.ts";

const p: Platform = {
  profile: { schema: 1, name: "ubuntu-desktop", tools: { "red-router": true } }, os: "linux", env: "desktop", distro: "ubuntu", version: "24.04", codename: "noble", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false } };
const roots: string[] = [];
let restore: (() => void) | undefined;
afterEach(() => { restore?.(); restore = undefined; roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "red-policy-")); roots.push(root);
  const env = { HOME: root, USERPROFILE: root, MISE_CONFIG_DIR: root, XDG_STATE_HOME: join(root, "state"), MISE_CONFIG_FILE: join(root, "mise.toml"), RED_DEV_POLICY_FILE: join(root, "policies.json") };
  const before = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  restore = () => { for (const [k, v] of Object.entries(before)) if (v === undefined) delete process.env[k]; else process.env[k] = v; };
  return env;
}
describe("explicit portable tool ownership", () => {
  test("keeps user selectors byte-for-byte through provider projection and excludes them from upgrade/prune", () => {
    const env = fixture();
    const original = '[tools]\n# my choice\nredcode = { version = "0.41.1", bin = "redcode" }\nclaude = "2.1.283"\nnode = "lts"\n';
    writeFileSync(env.MISE_CONFIG_FILE, original);
    expect(toolPolicy("node")).toEqual({ mode: "fixed", version: "lts" });
    expect(installSelector("claude")).toBe("claude@2.1.283");
    expect(miseEntries(p).find(e => e.alias === "redcode")?.version).toBe("0.41.1");
    expect(miseToolNames(p)).not.toContain("redcode");
    expect(miseToolSpecs(p)).not.toContain("github:reddb-io/redcode");
    expect(readFileSync(env.MISE_CONFIG_FILE, "utf8")).toBe(original);
    const claude = AGENTS.find(a => a.cmd === "claude")!;
    expect(planAgentUpdate(claude, p, { locate: name => `/tools/${name}`, npm: null }).state).toBe("skip");
  });
  test("external tools leave the generated fragment and both installation and updates", () => {
    fixture(); writeToolPolicy("red-router", { mode: "external" });
    expect(providerFor(TOOLS.find(t => t.name === "red-router")!, p).kind).toBe("skip");
    expect(miseEntries(p).some(e => e.alias === "red-router")).toBe(false);
    expect(installSelector("red-router")).toBeNull();
    writeToolPolicy("red-router", { mode: "follow" });
    expect(miseToolNames(p)).toContain("red-router");
  });
  test("a fixed red-dev makes no publisher request and never clears the mise cache", async () => {
    const env = fixture(); writeToolPolicy("red-dev", { mode: "fixed", version: "1.0.183" });
    const result = await updateRedDev({ current: "1.0.183", platform: p, latest: async () => { throw Error("must not request"); } });
    expect(result.reason).toContain("fixed");
    expect(toolPolicy("red-dev")).toEqual({ mode: "fixed", version: "1.0.183" });
    expect(policyPath(env)).toBe(env.RED_DEV_POLICY_FILE);
  });
  test("multiple global versions remain external and invalid configuration is never reset", () => {
    const env = fixture(); writeFileSync(env.MISE_CONFIG_FILE, '[tools]\nnode = ["20", "22"]\n');
    expect(toolPolicy("node")).toEqual({ mode: "external" });
    writeFileSync(env.RED_DEV_POLICY_FILE, "broken");
    expect(() => writeToolPolicy("node", { mode: "follow" })).toThrow();
    expect(readFileSync(env.RED_DEV_POLICY_FILE, "utf8")).toBe("broken");
  });
  test("the policy command carries all choices through the public parser", () => {
    const parsed = parseArgs(buildCli(), ["policy", "claude", "fixed", "2.1.283"]);
    expect(parsed.errors).toEqual([]);
    expect([parsed.policyTool, parsed.policyMode, parsed.policyVersion]).toEqual(["claude", "fixed", "2.1.283"]);
    expect(parseArgs(buildCli(), ["maintenance"]).errors).toEqual([]);
  });
  test("an explicit fixed/follow choice selects that one tool; external performs no package command", async () => {
    fixture(); const commands: string[][] = [];
    const run = async (argv: string[]) => { commands.push(argv); return 0; };
    expect(await policyCommand(p, "claude", "fixed", "2.1.283", { run })).toBe(0);
    expect(commands[0]).toEqual(["mise", "use", "-g", "--yes", "--pin", "claude@2.1.283"]);
    expect(await policyCommand(p, "claude", "follow", undefined, { run })).toBe(0);
    expect(commands[1]).toContain("claude@latest");
    expect(await policyCommand(p, "claude", "external", undefined, { run })).toBe(0);
    expect(commands).toHaveLength(2);
  });
  test("Windows reads and writes Linux-owned policies through the WSL owner", async () => {
    fixture();
    const windows = { ...p, os: "windows", workstation: "windows-wsl" } as Platform;
    const commands: string[] = [];
    const seams = { relay: async (_p: Platform, command: string) => { commands.push(command); return 0; },
      run: async () => { throw Error("must not install on Windows"); } };
    expect(await policyCommand(windows, "red-router", undefined, undefined, seams)).toBe(0);
    expect(await policyCommand(windows, "red-router", "fixed", "0.13.0", seams)).toBe(0);
    expect(commands).toEqual(["red-dev policy red-router", "red-dev policy red-router fixed 0.13.0"]);
    expect(toolPolicy("red-router")).toEqual({ mode: "follow" });
  });
});
