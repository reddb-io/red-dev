/**
 * 9router as a standing service, on every target.
 *
 * The manifest installs the router; this keeps it running. Installed and
 * stopped is the failure the hosts see: an agent configured against
 * http://localhost:20128/v1 on a machine where nothing listens there is
 * an agent that fails its first request after every boot, and the fix
 * — open a terminal, type `9router`, leave it open — is the fix nobody
 * remembers at 09:00. So the router is a user service under systemd
 * and a Startup-folder shortcut on Windows, and a converge brings both
 * up now rather than at the next logon.
 *
 * ## Why the service is not `9router`
 *
 * The package's own launcher, cli.js, is written for a person at a
 * terminal and does three things a service must not. On start it kills
 * every process whose command line mentions `next-server` — which on a
 * developer's machine is their Next.js dev server, not ours — and
 * anything listening on its port. It asks npm whether a newer version
 * exists and offers `npm i -g` to take it, which would put a second copy
 * beside the one mise owns. And with no TTY it falls into tray mode,
 * which under systemd means loading a system-tray binary into a session
 * that has no tray. Read against the real 0.5.69 tarball.
 *
 * What the launcher eventually does is one spawn: node on
 * `app/custom-server.js`, `cwd` at `app/`, with PORT, HOSTNAME and a
 * NODE_PATH pointing at the SQLite runtime it keeps under ~/.9router.
 * `red-dev 9router serve` is that spawn and nothing else, and it is
 * what the unit and the shortcut run. red-dev rather than the path to
 * the server, because mise moves that path on every upgrade and a unit
 * naming `installs/npm-9router/0.5.69/...` dies the day 0.5.70 lands.
 *
 * ## Loopback, one router per side
 *
 * The launcher binds 0.0.0.0 and prints a warning about it. The service
 * binds 127.0.0.1: a router carrying provider credentials has no business
 * on the LAN by default, and `RED_9ROUTER_HOST` is there for the machine
 * that wants otherwise. A WSL distro runs its own router, and so does the
 * Windows host beside it — under NAT networking a Windows loopback port
 * is not reachable from the distro, so a single shared router would
 * leave one side without one.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { DriftCheck } from "./drift.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/** The names this owns, on each side. */
export const ROUTER_SERVICE = "red-dev-9router.service";
export const ROUTER_SHORTCUT = "red-dev-9router.lnk";
export const ROUTER_WRAPPER = "red-dev-9router.cmd";

/** Where the dashboard and the API answer, when nothing says otherwise. */
export const DEFAULT_ROUTER_PORT = 20128;
export const DEFAULT_ROUTER_HOST = "127.0.0.1";

/** Whether the operator turned the service off. The package stays. */
export function routerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env["RED_9ROUTER"] ?? "1") !== "0";
}

/**
 * The port, from the environment, clamped rather than refused.
 *
 * Below 1024 needs root, which a user service does not have; above
 * 65535 is not a port. A converge must not fail over a number in a
 * shell file, so both ends fold back to the default.
 */
export function routerPort(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env["RED_9ROUTER_PORT"] ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1024 || parsed > 65535) return DEFAULT_ROUTER_PORT;
  return parsed;
}

/** The interface, from the environment. Loopback unless somebody says otherwise. */
export function routerHost(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env["RED_9ROUTER_HOST"] ?? "").trim();
  return raw === "" ? DEFAULT_ROUTER_HOST : raw;
}

/**
 * Where 9router keeps its database, credentials and runtime. PURE.
 *
 * The package's own convention, read from hooks/sqliteRuntime.js:
 * DATA_DIR wins, then %APPDATA%\9router on Windows and ~/.9router
 * elsewhere. Reproduced rather than left to the server because the
 * NODE_PATH the server needs points inside it.
 */
export function routerDataDir(
  env: NodeJS.ProcessEnv,
  platform: string,
  home: string,
): string {
  const explicit = env["DATA_DIR"];
  if (explicit) return explicit;
  if (platform === "win32") {
    const appData = env["APPDATA"];
    return appData ? join(appData, "9router") : join(home, "AppData", "Roaming", "9router");
  }
  return join(home, ".9router");
}

/**
 * The installed package, by path rather than by `$PATH`.
 *
 * mise's npm backend lays a tool out as
 * `<installs>/npm-9router/<version>/node_modules/9router`, verified
 * against a real install of 0.5.69. `latest` is preferred where mise
 * left one, because it is what mise moves on an upgrade; otherwise the
 * newest real version. Null when the manifest row has not run yet.
 */
export function locateRouterPackage(installRoot: string): string | null {
  const root = join(installRoot, "npm-9router");
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const candidates = ["latest", ...names.filter((n) => n !== "latest").sort(byVersionDesc)];
  for (const name of candidates) {
    const pkg = join(root, name, "node_modules", "9router");
    if (existsSync(join(pkg, "cli.js"))) return pkg;
  }
  return null;
}

/** Newest first, by numeric segments, so `0.5.70` sorts above `0.5.9`. */
function byVersionDesc(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).map((n) => Number.parseInt(n, 10));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const l = x[i];
    const r = y[i];
    if (l === undefined || Number.isNaN(l)) return 1;
    if (r === undefined || Number.isNaN(r)) return -1;
    if (l !== r) return r - l;
  }
  return 0;
}

/**
 * The server, as the launcher would have started it. PURE.
 *
 * Same node flags: `ipv4first` because the providers it dials publish
 * AAAA records that time out on machines without v6 routing, and the
 * heap ceiling because Next's standalone server holds every request
 * body it is compressing. `custom-server.js` where the package ships it
 * — it stamps the real peer address so rate-limiting keys on the socket
 * rather than on a header a client can forge — and `server.js` where an
 * older build does not.
 */
export function routerServeCommand(
  node: string,
  pkg: string,
  hasCustomServer: boolean,
): { argv: string[]; cwd: string } {
  const app = join(pkg, "app");
  const entry = join(app, hasCustomServer ? "custom-server.js" : "server.js");
  return {
    argv: [node, "--dns-result-order=ipv4first", "--max-old-space-size=6144", entry],
    cwd: app,
  };
}

/**
 * The environment the server reads. PURE.
 *
 * NODE_PATH is what makes better-sqlite3 resolvable: the package keeps
 * its native module under the data directory rather than in its own
 * tree, so a global upgrade on Windows never has to replace a `.node`
 * file that is in use. The bundled `app/node_modules` follows for
 * sql.js. Both come before anything the environment already carried.
 */
export function routerServeEnv(
  base: NodeJS.ProcessEnv,
  pkg: string,
  dataDir: string,
  port: number,
  host: string,
  delimiter: string,
): NodeJS.ProcessEnv {
  const nodePath = [join(dataDir, "runtime", "node_modules"), join(pkg, "app", "node_modules"), base["NODE_PATH"] ?? ""]
    .filter(Boolean)
    .join(delimiter);
  return {
    ...base,
    NODE_PATH: nodePath,
    PORT: String(port),
    HOSTNAME: host,
    NODE_ENV: "production",
  };
}

/** One POSIX-shell single-quoted word. PURE. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One `Environment=` assignment, quoted the way systemd reads them. PURE. */
function systemdQuote(assignment: string): string {
  return `"${assignment.replaceAll("%", "%%")}"`;
}

/**
 * The unit, as text. PURE.
 *
 * Through a login shell for the reason the RedSkills watch unit is: a
 * user service inherits systemd's six-directory PATH, and the node and
 * npm this needs are mise's, which the profile puts there. The
 * converge's own PATH rides behind it for what no profile can rebuild —
 * see src/watch-schedule.ts for the measurement that earned both.
 *
 * `Restart=on-failure` and not `always`: a clean exit is somebody
 * stopping it on purpose, and a unit that undoes that is a unit people
 * learn to `mask`. `default.target` is a user manager's "logged in",
 * which is when an agent might need the endpoint.
 */
export function routerUnit(binary: string, inheritedPath = ""): string {
  return [
    "# Generated by red-dev. Do not edit — `red-dev install` rewrites it.",
    "[Unit]",
    "Description=9router — one local endpoint for every coding agent",
    "",
    "[Service]",
    "Type=simple",
    ...(inheritedPath === "" ? [] : [`Environment=${systemdQuote(`RED_DEV_PATH=${inheritedPath}`)}`]),
    `ExecStart=/bin/bash -lc ${shellQuote(
      inheritedPath === ""
        ? `exec ${binary} 9router serve`
        : `PATH="$PATH:$RED_DEV_PATH"; exec ${binary} 9router serve`,
    )}`,
    "Restart=on-failure",
    "RestartSec=5s",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** What the Windows shortcut runs: a batch file, not a command line. PURE. */
export function routerWrapper(binary: string): string {
  return `@echo off\r\n"${binary}" 9router serve\r\n`;
}

/**
 * The PowerShell that puts the shortcut in the Startup folder. PURE.
 *
 * Startup rather than a scheduled task, for a long-lived process: a
 * task created by `schtasks /Create` carries the scheduler's default
 * three-day execution limit, after which it stops the router and
 * reports success. A Startup shortcut is Explorer's and has no clock.
 *
 * Through the hidden runner, because red-dev.exe is a console program
 * and one started at logon with no console of its own gets one drawn
 * — the black rectangle ADR 0009 recorded. `WindowStyle 7` is
 * minimised, belt to the runner's braces.
 *
 * Save() only when something differs, so a converge that changes
 * nothing leaves Explorer's registration alone.
 */
export function startupShortcutScript(runner: string, wrapper: string): string {
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const args = `//B //Nologo "${runner}" "${wrapper}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "$dir = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup'",
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    `$p = Join-Path $dir ${ps(ROUTER_SHORTCUT)}`,
    "$sh = New-Object -ComObject WScript.Shell",
    "$s = $sh.CreateShortcut($p)",
    `$target = 'wscript.exe'`,
    `$argv = ${ps(args)}`,
    "if ((Test-Path $p) -and ($s.TargetPath -eq $target) -and ($s.Arguments -eq $argv)) { 'same'; exit 0 }",
    "$s.TargetPath = $target",
    "$s.Arguments = $argv",
    "$s.WindowStyle = 7",
    "$s.Description = '9router, kept running by red-dev'",
    "$s.Save()",
    "'written'",
  ].join("\n");
}

/** The PowerShell that takes it back out. PURE. */
export function startupShortcutRemovalScript(): string {
  return [
    "$p = Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\" +
      ROUTER_SHORTCUT +
      "'",
    "if (Test-Path $p) { Remove-Item -Force $p; 'removed' } else { 'absent' }",
  ].join("\n");
}

/**
 * Whether something answers on the router's port.
 *
 * A TCP connect and nothing more: the question is "is there a listener",
 * and an HTTP request would turn a probe into a client the dashboard
 * logs. Bounded, because a firewall that drops rather than refuses
 * would otherwise hold doctor for the kernel's full timeout.
 */
export async function portAnswers(port: number, host = DEFAULT_ROUTER_HOST, timeoutMs = 800): Promise<boolean> {
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
        open(socket) {
          socket.end();
          finish(true);
        },
        data() {},
        close() {},
        error() {
          finish(false);
        },
        connectError() {
          finish(false);
        },
      },
    }).catch(() => finish(false));
  });
}

export interface RouterSeams {
  run?: (argv: string[], opts?: { timeoutMs?: number }) => Promise<{ exitCode: number | null; out?: string }>;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** The red-dev binary the unit or shortcut names. */
  binary?: string;
  /** Whether the port already answers, for the "start it now" decision. */
  answering?: () => Promise<boolean>;
  /** Start the Windows side now, detached. */
  startHidden?: (runner: string, wrapper: string) => void;
  /** Where the hidden runner is, or null when it could not be placed. */
  hiddenRunner?: () => Promise<string | null>;
}

/** What a converge did to the service, in one word for the log. */
export type RouterOutcome = "installed" | "unchanged" | "removed" | "skipped";

async function runner(seams: RouterSeams) {
  if (seams.run) return seams.run;
  const { runBounded } = await import("./bounded-command.ts");
  return async (argv: string[], opts: { timeoutMs?: number } = {}) => {
    const result = await runBounded(argv, { timeoutMs: opts.timeoutMs ?? 15_000 });
    return { exitCode: result.timedOut ? 1 : result.exitCode, out: result.stdout };
  };
}

function homeOf(seams: RouterSeams): string {
  return seams.home ?? (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "");
}

async function binaryOf(p: Platform, seams: RouterSeams): Promise<string> {
  if (seams.binary) return seams.binary;
  const { redwallBinary } = await import("./redwall-hook.ts");
  return await redwallBinary(p);
}

/** `~/.config/systemd/user`, beside the other units red-dev writes. */
export function routerUnitPath(home: string): string {
  return `${home}/.config/systemd/user/${ROUTER_SERVICE}`;
}

/**
 * Put the service in place, or take it away when it is turned off.
 *
 * Write-if-changed, then `enable --now` on every run: enabling an
 * enabled unit is a no-op and starting a running one is too, so the
 * idempotent form costs nothing and covers the machine where a person
 * stopped it by hand and forgot. A unit whose text moved is restarted,
 * because the running one is reading the old ExecStart.
 */
export async function convergeRouterAutostart(
  p: Platform,
  seams: RouterSeams = {},
): Promise<RouterOutcome> {
  const env = seams.env ?? process.env;
  if (p.os === "windows") return await convergeShortcut(p, seams, env);
  if (!p.caps.systemd) {
    log.skip("9router: no systemd user manager here — start it with `red-dev 9router serve`");
    return "skipped";
  }
  return await convergeUnit(p, seams, env);
}

async function convergeUnit(
  p: Platform,
  seams: RouterSeams,
  env: NodeJS.ProcessEnv,
): Promise<RouterOutcome> {
  const path = routerUnitPath(homeOf(seams));
  const run = await runner(seams);

  if (!routerEnabled(env)) {
    if (!existsSync(path)) return "unchanged";
    // Disabled before the file goes, or the symlink outlives it and
    // systemd complains for good.
    await run(["systemctl", "--user", "disable", "--now", ROUTER_SERVICE]);
    rmSync(path, { force: true });
    await run(["systemctl", "--user", "daemon-reload"]);
    log.ok("9router: the service is off (RED_9ROUTER=0)");
    return "removed";
  }

  const { inheritablePath } = await import("./watch-schedule.ts");
  const unit = routerUnit(await binaryOf(p, seams), inheritablePath(env));
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const changed = current !== unit;

  if (changed) {
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, unit);
    await run(["systemctl", "--user", "daemon-reload"]);
  }
  const enabled = await run(["systemctl", "--user", "enable", "--now", ROUTER_SERVICE]);
  if (enabled.exitCode !== 0) {
    log.warn("9router: the unit is written but systemd could not enable it — `systemctl --user status " + ROUTER_SERVICE + "`");
    return changed ? "installed" : "unchanged";
  }
  if (changed && current !== "") {
    // The running one is on the old text.
    await run(["systemctl", "--user", "restart", ROUTER_SERVICE]);
  }
  if (!changed) return "unchanged";
  log.ok(`9router: running as a user service on http://${routerHost(env)}:${routerPort(env)}`);
  return "installed";
}

async function convergeShortcut(
  p: Platform,
  seams: RouterSeams,
  env: NodeJS.ProcessEnv,
): Promise<RouterOutcome> {
  const run = await runner(seams);

  if (!routerEnabled(env)) {
    const removed = await run(["powershell.exe", "-NoProfile", "-Command", startupShortcutRemovalScript()]);
    if ((removed.out ?? "").includes("removed")) {
      log.ok("9router: the Startup shortcut is off (RED_9ROUTER=0)");
      return "removed";
    }
    return "unchanged";
  }

  const runnerPath = seams.hiddenRunner
    ? await seams.hiddenRunner()
    : await (await import("./redwall-hook.ts")).hiddenRunnerPath(p);
  if (runnerPath === null) {
    log.warn("9router: the hidden runner could not be installed; no Startup shortcut was written");
    return "skipped";
  }

  // In red-dev's own bin directory, never beside the binary: mise
  // deletes a version directory on upgrade, and a shortcut pointing into
  // one goes on firing at nothing. See src/watch-schedule.ts.
  const { windowsBinDir } = await import("./providers.ts");
  const wrapper = `${windowsBinDir()}\\${ROUTER_WRAPPER}`;
  const body = routerWrapper(await binaryOf(p, seams));
  let wrapperChanged = false;
  try {
    mkdirSync(wrapper.slice(0, wrapper.lastIndexOf("\\")), { recursive: true });
    const current = existsSync(wrapper) ? readFileSync(wrapper, "utf8") : "";
    if (current !== body) {
      writeFileSync(wrapper, body);
      wrapperChanged = true;
    }
  } catch (err) {
    log.warn(`9router: could not write ${wrapper}: ${(err as Error).message}`);
    return "skipped";
  }

  const written = await run(["powershell.exe", "-NoProfile", "-Command", startupShortcutScript(runnerPath, wrapper)]);
  if (written.exitCode !== 0) {
    log.warn("9router: PowerShell refused to write the Startup shortcut");
    return "skipped";
  }
  const shortcutChanged = (written.out ?? "").includes("written");

  // A shortcut fires at the next logon. This machine is logged in now.
  const answering = seams.answering ? await seams.answering() : await portAnswers(routerPort(env), routerHost(env));
  if (!answering) {
    const start = seams.startHidden ?? startHiddenDefault;
    start(runnerPath, wrapper);
    log.ok(`9router: started, and in the Startup folder for every logon — http://${routerHost(env)}:${routerPort(env)}`);
    return "installed";
  }
  if (shortcutChanged || wrapperChanged) {
    log.ok("9router: in the Startup folder for every logon");
    return "installed";
  }
  return "unchanged";
}

function startHiddenDefault(runnerPath: string, wrapper: string): void {
  // Not awaited: the runner waits for the server, which is the point of
  // the server. The child outlives this process on Windows, where no
  // job object ties it to the converge.
  const proc = Bun.spawn(["wscript.exe", "//B", "//Nologo", runnerPath, wrapper], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
}

/**
 * Take the service out, for `red-dev uninstall`.
 *
 * The package itself is mise's to remove, through the fragment; this is
 * only what red-dev put around it. The data directory is left exactly
 * where it is — it holds provider credentials the person entered, and a
 * backup nobody asked for is not this tool's to make or to delete.
 */
export async function removeRouterAutostart(p: Platform, seams: RouterSeams = {}): Promise<string[]> {
  const run = await runner(seams);
  const removed: string[] = [];
  if (p.os === "windows") {
    const result = await run(["powershell.exe", "-NoProfile", "-Command", startupShortcutRemovalScript()]);
    if ((result.out ?? "").includes("removed")) removed.push(`Startup\\${ROUTER_SHORTCUT}`);
    try {
      const { windowsBinDir } = await import("./providers.ts");
      const wrapper = `${windowsBinDir()}\\${ROUTER_WRAPPER}`;
      if (existsSync(wrapper)) {
        rmSync(wrapper, { force: true });
        removed.push(wrapper);
      }
    } catch {
      // No LOCALAPPDATA means no wrapper was ever written.
    }
    return removed;
  }
  const path = routerUnitPath(homeOf(seams));
  if (!existsSync(path)) return removed;
  if (p.caps.systemd) await run(["systemctl", "--user", "disable", "--now", ROUTER_SERVICE]);
  rmSync(path, { force: true });
  if (p.caps.systemd) await run(["systemctl", "--user", "daemon-reload"]);
  removed.push(path);
  return removed;
}

/**
 * What doctor says about it: declared, enabled, and answering.
 *
 * Two facts rather than one, because they fail differently. A unit
 * that is enabled and a port that is silent is a server that crashed
 * on start — `journalctl --user -u red-dev-9router` has the reason. A
 * port that answers with no unit is somebody's foreground `9router`,
 * which works until they close the terminal.
 */
export async function inspectRouter(p: Platform, seams: RouterSeams = {}): Promise<DriftCheck[]> {
  const env = seams.env ?? process.env;
  const port = routerPort(env);
  const host = routerHost(env);
  const name = "9router";
  const endpoint = `http://${host}:${port}`;

  if (!routerEnabled(env)) {
    return [{ name, status: "ok", detail: "service turned off (RED_9ROUTER=0)" }];
  }

  const answering = seams.answering ? await seams.answering() : await portAnswers(port, host);
  const run = await runner(seams);

  if (p.os === "windows") {
    const probe = await run([
      "powershell.exe",
      "-NoProfile",
      "-Command",
      `if (Test-Path (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs\\Startup\\${ROUTER_SHORTCUT}')) { 'present' } else { 'absent' }`,
    ]);
    const declared = (probe.out ?? "").includes("present");
    if (declared && answering) return [{ name, status: "ok", detail: `answering on ${endpoint}, in the Startup folder` }];
    if (declared) {
      return [{ name, status: "drift", detail: `in the Startup folder but nothing answers on ${endpoint}`, fix: "red-dev 9router serve" }];
    }
    return [{ name, status: "drift", detail: answering ? `answering on ${endpoint}, but not in the Startup folder` : "not in the Startup folder", fix: "red-dev install core" }];
  }

  if (!p.caps.systemd) {
    return [{
      name,
      status: answering ? "ok" : "n/a",
      detail: answering ? `answering on ${endpoint} (no systemd here)` : "no systemd user manager — nothing keeps it running",
    }];
  }

  const enabled = (await run(["systemctl", "--user", "is-enabled", ROUTER_SERVICE])).exitCode === 0;
  const active = (await run(["systemctl", "--user", "is-active", ROUTER_SERVICE])).exitCode === 0;
  if (enabled && active && answering) return [{ name, status: "ok", detail: `answering on ${endpoint}, as a user service` }];
  if (!enabled) {
    return [{ name, status: "drift", detail: answering ? `answering on ${endpoint}, but the user service is not enabled` : "the user service is not enabled", fix: "red-dev install core" }];
  }
  if (!active) {
    return [{ name, status: "drift", detail: "the user service is enabled but not running", fix: `systemctl --user start ${ROUTER_SERVICE}` }];
  }
  return [{ name, status: "drift", detail: `the service is running but nothing answers on ${endpoint}`, fix: `journalctl --user -u ${ROUTER_SERVICE} -n 50` }];
}

/**
 * Run the server in the foreground. The unit's ExecStart, and what a
 * person types where there is no unit.
 *
 * The SQLite runtime is checked first, the way the launcher checks it:
 * the package keeps better-sqlite3 outside its own tree and installs it
 * on first start. Bounded and non-fatal — sql.js is bundled, and a
 * server on the slower engine beats no server.
 *
 * Signals are forwarded and the child's exit code is ours, so systemd
 * sees the server's exit and not red-dev's opinion of it.
 */
export async function serveRouter(p: Platform, seams: RouterSeams = {}): Promise<number> {
  const env = seams.env ?? process.env;
  const home = homeOf(seams);
  const windows = p.os === "windows";

  const { miseInstallRoot, miseToolBin } = await import("./mise-config.ts");
  const pkg = locateRouterPackage(miseInstallRoot(env));
  if (pkg === null) {
    log.err("9router is not installed — `red-dev install core` puts it in place through mise");
    return 1;
  }

  const node = Bun.which("node") ?? miseToolBin("node");
  if (node === null) {
    log.err("no node on PATH or under mise — the `runtimes` row installs one");
    return 1;
  }

  const dataDir = routerDataDir(env, windows ? "win32" : "linux", home);
  const serveEnv = routerServeEnv(env, pkg, dataDir, routerPort(env), routerHost(env), windows ? ";" : ":");

  // The launcher's self-heal, run once, bounded. `silent` keeps its
  // progress off the journal; a failure is one line here and the server
  // still starts.
  const heal = Bun.spawn(
    [node, "-e", "require(process.argv[1]).ensureSqliteRuntime({ silent: true })", join(pkg, "hooks", "sqliteRuntime.js")],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: serveEnv },
  );
  const healTimer = setTimeout(() => heal.kill(), 180_000);
  if ((await heal.exited) !== 0) log.warn("9router: the SQLite runtime could not be prepared; continuing on the bundled engine");
  clearTimeout(healTimer);

  const { argv, cwd } = routerServeCommand(node, pkg, existsSync(join(pkg, "app", "custom-server.js")));
  log.step(`9router: serving http://${routerHost(env)}:${routerPort(env)} from ${pkg}`);
  const child = Bun.spawn(argv, { cwd, env: serveEnv, stdin: "ignore", stdout: "inherit", stderr: "inherit" });

  const forward = (signal: NodeJS.Signals) => () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };
  process.on("SIGTERM", forward("SIGTERM"));
  process.on("SIGINT", forward("SIGINT"));
  process.on("SIGHUP", forward("SIGHUP"));

  return (await child.exited) ?? 1;
}
