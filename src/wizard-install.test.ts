import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWizardInstall, type WizardInstallDependencies } from "./wizard-install.ts";
import { prepareProvisioning } from "./provisioning.ts";
import { acquireUpdateLock, withUpdateLock } from "./update-coordinator.ts";
import { buildCli, parseArgs } from "./cli.ts";
import { log, logIsCaptured } from "./log.ts";
import type { Platform } from "./platform.ts";
import type { SetupAnswers } from "./tui-setup-model.ts";
import type { ConvergeOptions, ConvergeSummary } from "./converge.ts";

const platform: Platform = { os: "linux", env: "desktop", distro: "ubuntu", version: "26.04", codename: "resolute", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false } };
const answers: SetupAnswers = { completed: true, theme: "ember", font: "firacode", apps: ["antigravity"],
  agents: [], runtimes: [], blesh: true, redwall: true, share: false };
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "red-wizard-install-")); roots.push(root);
  const path = join(root, "updates.json");
  const calls: string[] = [];
  const p = { ...platform };
  const summary: ConvergeSummary = { results: [], failed: 0, deferred: 0 };
  const protectedCall = (name: string) => {
    expect(existsSync(`${path}.lock/owner.json`)).toBe(true);
    calls.push(name);
  };
  const deps: WizardInstallDependencies = {
    lock: run => withUpdateLock(run, path),
    prepare: async () => { protectedCall("prepare"); log.info("preparing legacy configuration"); },
    synchronize: async () => { protectedCall("synchronize"); },
    apply: async (_p, _inv, given, observer) => {
      protectedCall("setup");
      p.profile = { schema: 1, name: "ubuntu-desktop", tools: {}, apps: given.apps };
      observer?.begin?.([]);
      return { answers: given };
    },
    context: async () => { protectedCall("context"); return { platform: p, theme: "ember", font: "firacode", opacity: 90 }; },
    converge: async options => {
      protectedCall("converge");
      expect(options.ctx.theme).toBe("ember");
      expect(options.scopes).toContain("optional");
      return summary;
    },
  };
  const inv = parseArgs(buildCli(), []);
  const options: ConvergeOptions = { platform: p, ctx: { platform: p, theme: "carbon", font: "jetbrains", opacity: 90 }, scopes: ["core"], dryRun: false };
  return { root, path, calls, p, deps, inv, options, summary };
}

test("cancelled or incomplete wizard has no writes and never starts preparation", async () => {
  const f = fixture();
  const wizard = createWizardInstall(f.p, f.inv, f.deps);
  expect(f.calls).toEqual([]);
  await expect(wizard.apply({ ...answers, completed: false })).rejects.toThrow("not completed");
  expect(f.calls).toEqual([]);
  expect(existsSync(`${f.path}.lock`)).toBe(false);
});

test("migration, setup packages and convergence share one lease and use the final choices", async () => {
  const f = fixture(); const notes: string[] = [];
  const wizard = createWizardInstall(f.p, f.inv, f.deps);
  let setupReported = false;
  await wizard.apply(answers, { begin: () => { setupReported = true; } });
  expect(f.calls).toEqual([]);
  expect(await wizard.converge(f.options, { note: line => notes.push(line) })).toBe(f.summary);
  expect(f.calls).toEqual(["prepare", "setup", "synchronize", "context", "converge"]);
  expect(setupReported).toBe(true);
  expect(notes.some(line => line.includes("preparing legacy configuration"))).toBe(true);
  expect(existsSync(`${f.path}.lock`)).toBe(false);
  expect(logIsCaptured()).toBe(false);
});

test("a busy writer prevents every mutation, including setup package installs", async () => {
  const f = fixture(); const release = acquireUpdateLock(f.path)!;
  try {
    const wizard = createWizardInstall(f.p, f.inv, f.deps);
    await wizard.apply(answers);
    await expect(wizard.converge(f.options)).rejects.toThrow("another installation");
    expect(f.calls).toEqual([]);
  } finally { release(); }
});

test("a rejected preparation never applies choices and releases capture and lease", async () => {
  const f = fixture();
  f.deps.prepare = async () => { f.calls.push("prepare"); throw new Error("invalid legacy configuration"); };
  const wizard = createWizardInstall(f.p, f.inv, f.deps); await wizard.apply(answers);
  await expect(wizard.converge(f.options)).rejects.toThrow("invalid legacy configuration");
  expect(f.calls).toEqual(["prepare"]);
  expect(existsSync(`${f.path}.lock`)).toBe(false);
  expect(logIsCaptured()).toBe(false);
});

test("a failed setup cannot report success by continuing into package convergence", async () => {
  const f = fixture();
  f.deps.apply = async () => { f.calls.push("setup"); throw new Error("invalid preferences"); };
  const wizard = createWizardInstall(f.p, f.inv, f.deps); await wizard.apply(answers);
  await expect(wizard.converge(f.options)).rejects.toThrow("invalid preferences");
  expect(f.calls).toEqual(["prepare", "setup"]);
  expect(existsSync(`${f.path}.lock`)).toBe(false);
  expect(logIsCaptured()).toBe(false);
});

test("dry runs never acquire the writer or apply queued setup choices", async () => {
  const f = fixture();
  f.deps.converge = async options => { expect(options.dryRun).toBe(true); return f.summary; };
  const wizard = createWizardInstall(f.p, f.inv, f.deps); await wizard.apply(answers);
  expect(await wizard.converge({ ...f.options, dryRun: true })).toBe(f.summary);
  expect(f.calls).toEqual([]);
  expect(existsSync(`${f.path}.lock`)).toBe(false);
});

test("shared preparation applies migrations before adopting and declaring the machine", async () => {
  const calls: string[] = [];
  const deps = { migrate: async () => { calls.push("migrate"); }, adopt: async () => { calls.push("adopt"); },
    declareMise: () => { calls.push("declare"); } };
  await prepareProvisioning(platform, true, deps);
  expect(calls).toEqual([]);
  await prepareProvisioning(platform, false, deps);
  expect(calls).toEqual(["migrate", "adopt", "declare"]);
});

test("the public install, update and menu wire the shared preparation", () => {
  const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");
  const install = source.slice(source.indexOf("async function cmdInstallUnlocked"), source.indexOf("async function cmdUpdate("));
  expect(install.indexOf("prepareProvisioning(p, inv.dryRun)")).toBeLessThan(install.indexOf("carryOutChoices(p, choices)"));
  expect(install).toContain("prepareProvisioning(p, inv.dryRun)");
  const update = source.slice(source.indexOf("async function cmdUpdateUnlocked"), source.indexOf("async function cmdTheme"));
  expect(update).toContain("prepareProvisioning(p, inv.dryRun)");
  const menu = source.slice(source.indexOf("async function cmdUi"), source.indexOf("async function cmdMenu"));
  expect(menu).toContain("apply: installer.apply");
  expect(menu).toContain("installer.converge(");
});
