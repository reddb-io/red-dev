/** Keep the official RedRouter package running on every target. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

import type { DriftCheck } from "./drift.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

export const ROUTER_SERVICE = "red-router.service";
export const LEGACY_ROUTER_SERVICE = "red-dev-9router.service";
export const ROUTER_SHORTCUT = "red-dev-red-router.lnk";
export const LEGACY_ROUTER_SHORTCUT = "red-dev-9router.lnk";
export const ROUTER_WRAPPER = "red-dev-red-router.cmd";
export const LEGACY_ROUTER_WRAPPER = "red-dev-9router.cmd";
export const DEFAULT_ROUTER_PORT = 25050;
export const DEFAULT_ROUTER_HOST = "127.0.0.1";

export type RouterOutcome = "installed" | "unchanged" | "removed" | "skipped";

export interface RouterSeams {
  run?: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number | null; out?: string }>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  routerBinary?: string | null;
  miseBinary?: string | null;
  answering?: () => Promise<boolean>;
  startHidden?: (runner: string, wrapper: string) => void;
  hiddenRunner?: () => Promise<string | null>;
}

export function routerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["RED_ROUTER"] ?? "1") !== "0";
}

export function routerPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env["RED_ROUTER_PORT"] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 1024 && parsed <= 65535 ? parsed : DEFAULT_ROUTER_PORT;
}

export function routerHost(env: NodeJS.ProcessEnv = process.env): string {
  return env["RED_ROUTER_HOST"]?.trim() || DEFAULT_ROUTER_HOST;
}

async function runner(seams: RouterSeams) {
  if (seams.run) return seams.run;
  const { runBounded } = await import("./bounded-command.ts");
  return async (argv: string[], opts: { timeoutMs?: number } = {}) => {
    const result = await runBounded(argv, { timeoutMs: opts.timeoutMs ?? 180_000 });
    return { exitCode: result.timedOut ? 1 : result.exitCode, out: result.stdout };
  };
}

async function routerArgv(args: string[], seams: RouterSeams): Promise<string[] | null> {
  const { miseToolBin } = await import("./mise-config.ts");
  const direct = seams.routerBinary === undefined
    ? (Bun.which("red-router") ?? miseToolBin("red-router"))
    : seams.routerBinary;
  if (direct) return [direct, ...args];

  const mise = seams.miseBinary === undefined ? Bun.which("mise") : seams.miseBinary;
  return mise ? [mise, "exec", "red-router", "--", "red-router", ...args] : null;
}

export async function portAnswers(
  port: number,
  host = DEFAULT_ROUTER_HOST,
  timeoutMs = 800,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (answer: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(answer);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open(socket) { socket.end(); finish(true); },
        data() {},
        close() {},
        error() { finish(false); },
        connectError() { finish(false); },
      },
    }).catch(() => finish(false));
  });
}

function homeOf(seams: RouterSeams): string {
  return seams.home ?? process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
}

function legacyUnitPath(home: string): string {
  return `${home}/.config/systemd/user/${LEGACY_ROUTER_SERVICE}`;
}

function routerUnitPath(home: string): string {
  return `${home}/.config/systemd/user/${ROUTER_SERVICE}`;
}

/** A live process owes one restart exactly when its generated definition moved. */
export function routerServiceNeedsRestart(
  before: string | null,
  after: string | null,
  wasActive: boolean,
): boolean {
  return wasActive && before !== after && after !== null;
}

function readOptional(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

async function retireLegacyLinux(run: Awaited<ReturnType<typeof runner>>, home: string): Promise<boolean> {
  const path = legacyUnitPath(home);
  const declared = existsSync(path);
  const enabled = (await run(["systemctl", "--user", "is-enabled", LEGACY_ROUTER_SERVICE])).exitCode === 0;
  if (!declared && !enabled) {
    await run(["systemctl", "--user", "reset-failed", LEGACY_ROUTER_SERVICE]);
    return false;
  }
  await run(["systemctl", "--user", "disable", "--now", LEGACY_ROUTER_SERVICE]);
  rmSync(path, { force: true });
  await run(["systemctl", "--user", "daemon-reload"]);
  // systemd remembers a failed unit after its file is gone. Clear that
  // tombstone so `list-units --all` does not keep showing 9router.
  await run(["systemctl", "--user", "reset-failed", LEGACY_ROUTER_SERVICE]);
  return true;
}

function shortcutRemovalScript(names: string[]): string {
  const quoted = names.map((name) => `'${name.replaceAll("'", "''")}'`).join(",");
  return [
    "$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'",
    "$removed = $false",
    `@(${quoted}) | ForEach-Object { $p = Join-Path $dir $_; if (Test-Path $p) { Remove-Item -Force $p; $removed = $true } }`,
    "if ($removed) { 'removed' } else { 'absent' }",
  ].join("\n");
}

export function startupShortcutScript(runnerPath: string, wrapper: string): string {
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const args = `//B //Nologo "${runnerPath}" "${wrapper}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    `$p = Join-Path $dir ${ps(ROUTER_SHORTCUT)}`,
    "$sh = New-Object -ComObject WScript.Shell",
    "$s = $sh.CreateShortcut($p)",
    "$target = 'wscript.exe'",
    `$argv = ${ps(args)}`,
    "if ((Test-Path $p) -and ($s.TargetPath -eq $target) -and ($s.Arguments -eq $argv)) { 'same'; exit 0 }",
    "$s.TargetPath = $target",
    "$s.Arguments = $argv",
    "$s.WindowStyle = 7",
    "$s.Description = 'RedRouter, kept running by red-dev'",
    "$s.Save()",
    "'written'",
  ].join("\n");
}

export function routerWrapper(mise: string, port: number, host: string): string {
  return `@echo off\r\n"${mise}" exec red-router -- red-router -t --skip-update -n -p ${port} -H "${host}"\r\n`;
}

async function retireLegacyPackage(run: Awaited<ReturnType<typeof runner>>, seams: RouterSeams): Promise<void> {
  const mise = seams.miseBinary === undefined ? Bun.which("mise") : seams.miseBinary;
  if (!mise) return;
  const result = await run([mise, "uninstall", "--all", "9router"], { timeoutMs: 180_000 });
  if (result.exitCode !== 0) return;

  // mise removes the version but leaves the old `latest`, `0` and `0.5`
  // links behind. This directory belongs to the managed package and is
  // safe to retire only after mise confirms the uninstall.
  const { miseInstallRoot } = await import("./mise-config.ts");
  rmSync(`${miseInstallRoot(seams.env ?? process.env)}/9router`, { recursive: true, force: true });
}

async function convergeLinux(p: Platform, seams: RouterSeams, env: NodeJS.ProcessEnv): Promise<RouterOutcome> {
  if (!p.caps.systemd) {
    log.skip("red-router: no systemd user manager here — run `red-router -t`");
    return "skipped";
  }
  const run = await runner(seams);
  const home = homeOf(seams);
  const unitPath = routerUnitPath(home);
  const before = readOptional(unitPath);
  const wasActive = (await run(["systemctl", "--user", "is-active", ROUTER_SERVICE])).exitCode === 0;
  const retired = await retireLegacyLinux(run, home);
  const argv = await routerArgv(["service", routerEnabled(env) ? "install" : "uninstall", "-p", String(routerPort(env)), "-H", routerHost(env)], seams);
  if (!argv) {
    log.warn("red-router: package is not installed — `red-dev install red-router`");
    return "skipped";
  }
  const result = await run(argv);
  if (result.exitCode !== 0) throw new Error(`red-router service ${routerEnabled(env) ? "install" : "uninstall"} exited ${result.exitCode}`);
  if (routerEnabled(env)) {
    const after = readOptional(unitPath);
    if (routerServiceNeedsRestart(before, after, wasActive)) {
      const restarted = await run(["systemctl", "--user", "restart", ROUTER_SERVICE]);
      if (restarted.exitCode !== 0) {
        throw new Error("red-router service definition moved, but its running process could not be restarted");
      }
    }
    await retireLegacyPackage(run, seams);
    log.ok(`red-router: running as ${ROUTER_SERVICE} on http://${routerHost(env)}:${routerPort(env)}`);
    return retired || before !== after ? "installed" : "unchanged";
  }
  log.ok("red-router: service is off (RED_ROUTER=0)");
  return "removed";
}

async function convergeWindows(p: Platform, seams: RouterSeams, env: NodeJS.ProcessEnv): Promise<RouterOutcome> {
  const run = await runner(seams);
  await run(["powershell.exe", "-NoProfile", "-Command", shortcutRemovalScript([LEGACY_ROUTER_SHORTCUT])]);
  const { windowsBinDir } = await import("./providers.ts");
  const binDir = windowsBinDir();
  const wrapper = `${binDir}\\${ROUTER_WRAPPER}`;
  try { rmSync(`${binDir}\\${LEGACY_ROUTER_WRAPPER}`, { force: true }); } catch {}

  if (!routerEnabled(env)) {
    await run(["powershell.exe", "-NoProfile", "-Command", shortcutRemovalScript([ROUTER_SHORTCUT])]);
    rmSync(wrapper, { force: true });
    return "removed";
  }
  const mise = seams.miseBinary === undefined ? Bun.which("mise") : seams.miseBinary;
  if (!mise) {
    log.warn("red-router: mise is unavailable, so the Startup shortcut could not be written");
    return "skipped";
  }
  const hidden = seams.hiddenRunner
    ? await seams.hiddenRunner()
    : await (await import("./redwall-hook.ts")).hiddenRunnerPath(p);
  if (!hidden) return "skipped";

  const body = routerWrapper(mise, routerPort(env), routerHost(env));
  mkdirSync(wrapper.slice(0, wrapper.lastIndexOf("\\")), { recursive: true });
  const changed = !existsSync(wrapper) || readFileSync(wrapper, "utf8") !== body;
  if (changed) writeFileSync(wrapper, body);
  const shortcut = await run(["powershell.exe", "-NoProfile", "-Command", startupShortcutScript(hidden, wrapper)]);
  if (shortcut.exitCode !== 0) return "skipped";
  const answering = seams.answering ? await seams.answering() : await portAnswers(routerPort(env), routerHost(env));
  if (!answering) (seams.startHidden ?? startHiddenDefault)(hidden, wrapper);
  await retireLegacyPackage(run, seams);
  log.ok(`red-router: in the Startup folder on http://${routerHost(env)}:${routerPort(env)}`);
  return changed || (shortcut.out ?? "").includes("written") ? "installed" : "unchanged";
}

function startHiddenDefault(runnerPath: string, wrapper: string): void {
  const proc = Bun.spawn(["wscript.exe", "//B", "//Nologo", runnerPath, wrapper], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  proc.unref();
}

export async function convergeRouterAutostart(p: Platform, seams: RouterSeams = {}): Promise<RouterOutcome> {
  const env = seams.env ?? process.env;
  return p.os === "windows" ? await convergeWindows(p, seams, env) : await convergeLinux(p, seams, env);
}

export async function removeRouterAutostart(p: Platform, seams: RouterSeams = {}): Promise<string[]> {
  const run = await runner(seams);
  const removed: string[] = [];
  if (p.os === "windows") {
    const result = await run(["powershell.exe", "-NoProfile", "-Command", shortcutRemovalScript([ROUTER_SHORTCUT, LEGACY_ROUTER_SHORTCUT])]);
    if ((result.out ?? "").includes("removed")) removed.push(`Startup\\${ROUTER_SHORTCUT}`);
    return removed;
  }
  for (const service of [ROUTER_SERVICE, LEGACY_ROUTER_SERVICE]) {
    if (p.caps.systemd) await run(["systemctl", "--user", "disable", "--now", service]);
  }
  const legacy = legacyUnitPath(homeOf(seams));
  if (existsSync(legacy)) { rmSync(legacy, { force: true }); removed.push(legacy); }
  if (p.caps.systemd) await run(["systemctl", "--user", "daemon-reload"]);
  return removed;
}

export async function inspectRouter(p: Platform, seams: RouterSeams = {}): Promise<DriftCheck[]> {
  const env = seams.env ?? process.env;
  const name = "red-router";
  if (!routerEnabled(env)) return [{ name, status: "ok", detail: "service turned off (RED_ROUTER=0)" }];
  const answering = seams.answering ? await seams.answering() : await portAnswers(routerPort(env), routerHost(env));
  const run = await runner(seams);
  if (p.os === "windows") {
    const probe = await run(["powershell.exe", "-NoProfile", "-Command", `$p = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${ROUTER_SHORTCUT}'; if (Test-Path $p) { 'present' } else { 'absent' }`]);
    const declared = (probe.out ?? "").includes("present");
    return [{ name, status: declared && answering ? "ok" : "drift", detail: declared ? (answering ? `answering on http://${routerHost(env)}:${routerPort(env)}, in the Startup folder` : "in the Startup folder but not answering") : "not in the Startup folder", fix: declared && answering ? undefined : "red-dev install core" }];
  }
  if (!p.caps.systemd) return [{ name, status: answering ? "ok" : "n/a", detail: answering ? "answering without systemd" : "no systemd user manager" }];
  const enabled = (await run(["systemctl", "--user", "is-enabled", ROUTER_SERVICE])).exitCode === 0;
  const active = (await run(["systemctl", "--user", "is-active", ROUTER_SERVICE])).exitCode === 0;
  if (enabled && active && answering) return [{ name, status: "ok", detail: `answering on http://${routerHost(env)}:${routerPort(env)}, as ${ROUTER_SERVICE}` }];
  const fix = !enabled ? "red-dev install core" : !active ? `systemctl --user start ${ROUTER_SERVICE}` : `journalctl --user -u ${ROUTER_SERVICE} -n 50`;
  return [{ name, status: "drift", detail: !enabled ? "user service is not enabled" : !active ? "user service is not running" : "service is running but the endpoint is silent", fix }];
}

export async function manageRouterService(p: Platform, verb: string, seams: RouterSeams = {}): Promise<number> {
  if (verb === "install") { await convergeRouterAutostart(p, seams); return 0; }
  if (verb === "uninstall") { await removeRouterAutostart(p, seams); return 0; }
  if (verb !== "status") return 1;
  const checks = await inspectRouter(p, seams);
  return checks.every((check) => check.status !== "drift") ? 0 : 1;
}
