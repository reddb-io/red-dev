/** Windows coordinates its selected Ubuntu distro; Linux never calls back. */
import { VERSION } from "./cli.ts";
import { AGENTS } from "./agents.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, writePreferences, type TerminalShell } from "./preferences.ts";
import { spawnLogged, spawnInteractive } from "./providers.ts";
import { isKnownRuntimeId, runtimeIdsForPolicy } from "./runtimes.ts";
import { detectWsl, installWsl, type WslDistribution, type WslState } from "./wsl-provision.ts";
import { readWindowsOutput } from "./windows-output.ts";
import { unattendedShellCommand } from "./unattended.ts";
import { windowsWsl } from "./workstation.ts";
import { githubToken } from "./github-token.ts";

const BOOT_URL = "https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh";
export const DEFAULT_WSL_DISTRO = "Ubuntu-24.04";

export function selectDistro(state: WslState, pinned?: string): WslDistribution | null {
  if (pinned) return state.distributions.find(d => d.name === pinned) ?? null;
  const ubuntu = state.distributions.filter(d => /^Ubuntu(?:[- ]|$)/i.test(d.name));
  return ubuntu.find(d => d.default) ?? ubuntu[0] ?? null;
}

/** Forward gh's current identity only to this child; never put credentials in argv. */
export function wslChildEnvironment(current: NodeJS.ProcessEnv = process.env, token = githubToken(current)): NodeJS.ProcessEnv {
  const forwarded = new Set((current.WSLENV ?? "").split(":").filter(Boolean));
  for (const name of ["RED_ROUTER", "RED_ROUTER_HOST", "RED_ROUTER_PORT"]) if (current[name] !== undefined) forwarded.add(name);
  if (token) { forwarded.add("GH_TOKEN"); forwarded.add("GITHUB_TOKEN"); }
  return { ...current, ...(token ? { GH_TOKEN: token, GITHUB_TOKEN: token } : {}), WSLENV: [...forwarded].join(":") };
}

export function distroSetupCommands(shell: TerminalShell | undefined, agentKeys: string[], runtimeIds: string[]): string[] {
  if (shell !== "wsl") return [];
  const runtimes = runtimeIdsForPolicy(runtimeIds, "latest").filter(isKnownRuntimeId);
  const agents = agentKeys.filter(key => AGENTS.some(a => a.key === key));
  return [
    ...(runtimes.length ? [`red-dev lang ${runtimes.join(",")}`] : []),
    ...(agents.length ? [`red-dev agents ${agents.join(",")}`] : []),
  ];
}

export function distroArgv(distro: string, command: string, unattended = true): string[] {
  const child = unattended
    ? unattendedShellCommand(command, { RED_DEV_WSL_CHILD: "1" })
    : `env RED_DEV_WSL_CHILD=1 ${command}`;
  return ["wsl.exe", "-d", distro, "--", "bash", "-lc", child];
}

async function runDistro(distro: string, command: string, attached = false, unattended = false): Promise<number> {
  const { interactive } = await import("./ui.ts");
  if (!unattended && (attached || /^red-dev (?:install|update)\b/.test(command)) && interactive() && process.env.RED_DEV_UNATTENDED !== "1") {
    // sudo's credential belongs to this PTY. Authenticate and provision in
    // the same WSL invocation; a separate sudo -v loses that credential.
    const argv = distroArgv(distro, command, !attached);
    if (attached) argv.splice(3, 0, "--cd", process.cwd());
    if (!attached) argv[argv.length - 1] = `sudo --validate && ${argv.at(-1)}`;
    return spawnInteractive(argv, { env: wslChildEnvironment() });
  }
  return spawnLogged(distroArgv(distro, command), { env: wslChildEnvironment() });
}

/** Bounded read-only observation; drain both streams even when WSL reports an error. */
async function inDistro(distro: string, script: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["wsl.exe", "-d", distro, "--", "bash", "-lc", script], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const timer = setTimeout(() => proc.kill(), 15_000);
  try {
    const [out, , code] = await Promise.all([readWindowsOutput(proc.stdout), readWindowsOutput(proc.stderr), proc.exited]);
    return { out: out.trim(), code };
  } finally { clearTimeout(timer); }
}

export async function defaultDistroInfo(p?: Platform): Promise<WslDistribution | null> {
  const pinned = p?.wslDistro ?? (p ? (await readPreferences(p)).distro : undefined);
  return selectDistro(await detectWsl(), pinned);
}
export async function defaultDistro(): Promise<string | null> { return (await defaultDistroInfo())?.name ?? null; }
export async function distroVersion(distro: string): Promise<string | null> {
  const { out, code } = await inDistro(distro, "red-dev --version 2>/dev/null");
  const line = out.split("\n").pop()?.trim() ?? "";
  return code === 0 && /^\d+\.\d+\.\d+$/.test(line) ? line : null;
}
export interface SyncPlan { install: boolean; how: "bootstrap" | "upgrade"; reason: string; }
export function planFor(version: string | null, ours = VERSION): SyncPlan {
  return version === null ? { install: true, how: "bootstrap", reason: "no red-dev in the distro" }
    : { install: version !== ours, how: "upgrade", reason: version === ours ? `distro already on ${ours}` : `distro has ${version}, this is ${ours}` };
}
function bootstrapArgv(distro: string): string[] {
  return distroArgv(distro, `curl -fsSL ${BOOT_URL} | ${unattendedShellCommand("sh", { RED_DEV_NO_LAUNCH: "1" })}`);
}
export interface DistroRedDevSeams {
  version?: typeof distroVersion;
  bootstrap?: (distro: string) => Promise<number>;
  install?: (distro: string, command: string) => Promise<number>;
}
export async function ensureDistroRedDev(distro: string, seams: DistroRedDevSeams = {}): Promise<number> {
  const version = seams.version ?? distroVersion;
  const plan = planFor(await version(distro));
  log.step(`Ubuntu/WSL ${distro}: ${plan.reason}`);
  if (!plan.install) return 0;
  if (plan.how === "bootstrap") {
    const boot = seams.bootstrap ? await seams.bootstrap(distro)
      : await spawnLogged(bootstrapArgv(distro), { env: wslChildEnvironment() });
    if (boot !== 0) return boot;
  }
  // GitHub backend metadata may still resolve latest to the previous release
  // immediately after publication. Install the coordinator's exact version;
  // `install` leaves the user's moving selector and unrelated tools intact.
  const command = unattendedShellCommand(`mise install red-dev@${VERSION}`, { MISE_MINIMUM_RELEASE_AGE: "0" });
  const code = await (seams.install ?? runDistro)(distro, command);
  const now = code === 0 ? await version(distro) : null;
  if (now !== VERSION) {
    log.err(`${distro}: expected red-dev ${VERSION}, observed ${now ?? "unavailable"}; run red-dev update from PowerShell and retry`);
    return 1;
  }
  return 0;
}

export interface WslSyncSeams {
  state?: () => Promise<WslState>;
  install?: (distro: string, unattended?: boolean) => Promise<boolean>;
  ensure?: (distro: string) => Promise<number>;
  run?: (distro: string, command: string) => Promise<number>;
  preferences?: typeof readPreferences;
  record?: typeof writePreferences;
  user?: (distro: string) => Promise<boolean>;
  migrate?: (p: Platform, distro: string) => Promise<void>;
  action?: "install" | "update";
  unattended?: boolean;
  scope?: "core" | "desktop" | "wsl" | "optional";
  prepare?: (p: Platform, distro: string, run: (distro: string, command: string) => Promise<number>) => Promise<void>;
}

export async function syncSelectedTooling(p: Platform, knownDistro?: WslDistribution, seams: WslSyncSeams = {}): Promise<number> {
  if (p.os !== "windows" || process.env.RED_DEV_NO_WSL_SYNC === "1") return 0;
  const prefs = await (seams.preferences ?? readPreferences)(p);
  const commands = distroSetupCommands(windowsWsl(p) ? "wsl" : prefs.terminalShell, prefs.agents ?? [], prefs.runtimes ?? []);
  if (!commands.length) return 0;
  const selected = knownDistro ?? selectDistro(await (seams.state ?? detectWsl)(), p.wslDistro ?? prefs.distro);
  if (!selected || selected.version !== 2) { log.err("Ubuntu/WSL tooling: selected Ubuntu distro is absent or is not WSL 2"); return 1; }
  if (await (seams.ensure ?? ensureDistroRedDev)(selected.name) !== 0) return 1;
  let failures = 0;
  for (const command of commands) {
    log.step(`Ubuntu/WSL ${selected.name}: ${command}`);
    if (await (seams.run ?? runDistro)(selected.name, command) !== 0) failures++;
  }
  return failures;
}

/** Every child failure belongs to the same workstation result as its host. */
export async function syncWslDistro(p: Platform, seams: WslSyncSeams = {}): Promise<void> {
  if (p.os !== "windows" || !windowsWsl(p)) { log.skip("Ubuntu/WSL coordination: Windows native mode or local Linux"); return; }
  if (process.env.RED_DEV_NO_WSL_SYNC === "1") throw new RedError("Ubuntu/WSL coordination disabled (RED_DEV_NO_WSL_SYNC=1); workstation is incomplete");
  const prefs = await (seams.preferences ?? readPreferences)(p);
  let state = await (seams.state ?? detectWsl)();
  const execute = seams.run ?? ((distro: string, command: string) => runDistro(distro, command, false, seams.unattended));
  const pinned = p.wslDistro ?? prefs.distro;
  let selected = selectDistro(state, pinned);
  if (!selected) {
    const name = pinned ?? DEFAULT_WSL_DISTRO;
    if (!(await (seams.install ?? installWsl)(name, seams.unattended))) throw new RedError("Ubuntu/WSL installation pending; finish Windows setup, then run red-dev install from PowerShell");
    state = await (seams.state ?? detectWsl)();
    selected = selectDistro(state, name);
  }
  if (!selected || selected.version !== 2) throw new RedError("Ubuntu/WSL is not ready as WSL 2; finish distro initialization, then run red-dev install from PowerShell");
  const userReady = seams.user ? await seams.user(selected.name) : await distroUserReady(selected.name);
  if (!userReady) throw new RedError(`${selected.name}: finish Ubuntu's user setup first, then retry red-dev install from PowerShell; provisioning as root is refused`);
  p.wslDistro = selected.name;
  await (seams.record ?? writePreferences)(p, { terminalShell: "wsl", distro: selected.name });
  if (await (seams.ensure ?? ensureDistroRedDev)(selected.name) !== 0) throw new RedError(`${selected.name}: red-dev could not be updated`);
  await (seams.prepare ?? (await import("./windows-wsl-migration.ts")).prepareWindowsRouterData)(p, selected.name, execute);
  const command = seams.action === "update" ? "red-dev update --yes" : "red-dev install --yes";
  if (await execute(selected.name, command) !== 0) throw new RedError(`${selected.name}: Linux installation incomplete; retry red-dev install from PowerShell`);
  if (seams.scope === "optional" && await execute(selected.name, "red-dev install optional --yes") !== 0) throw new RedError(`${selected.name}: optional Linux packages failed`);
  if (await syncSelectedTooling(p, selected, { ...seams, run: execute, ensure: async () => 0 }) !== 0) throw new RedError(`${selected.name}: selected Linux tools failed`);
  const services = process.env.RED_ROUTER === "0" ? "redskilled.service" : "redskilled.service red-router.service";
  if (await execute(selected.name, `systemctl --user is-active ${services}`) !== 0) throw new RedError(`${selected.name}: Linux services are not active; finish WSL systemd setup and retry from PowerShell`);
  const migrate = seams.migrate ?? (await import("./windows-wsl-migration.ts")).retireWindowsServices;
  await migrate(p, selected.name);
  log.ok(`Windows + Ubuntu/WSL ${selected.name}: configured`);
}

async function distroUserReady(distro: string): Promise<boolean> {
  const uid = await inDistro(distro, "id -u");
  return uid.code === 0 && /^\d+$/.test(uid.out) && Number(uid.out) > 0;
}

/** Public read-only commands and explicit repair all use the selected distro. */
export async function relayWslCommand(p: Platform, command: string, seams: WslSyncSeams = {}, attached = false): Promise<number> {
  const prefs = await (seams.preferences ?? readPreferences)(p);
  const selected = selectDistro(await (seams.state ?? detectWsl)(), p.wslDistro ?? prefs.distro);
  if (!selected || selected.version !== 2) { log.err("Ubuntu/WSL: selected distro is not ready; run red-dev install from PowerShell"); return 1; }
  log.step(`Ubuntu/WSL ${selected.name}`);
  return seams.run ? seams.run(selected.name, command) : runDistro(selected.name, command, attached);
}

/** Quote user arguments before crossing bash's command-string boundary. */
export function wslCommand(words: string[]): string {
  return words.map(word => `'${word.replaceAll("'", `'"'"'`)}'`).join(" ");
}
