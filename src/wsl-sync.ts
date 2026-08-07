/**
 * The Windows side, reaching into its own distro.
 *
 * A Windows machine running WSL is two machines. They have separate
 * home directories, separate PATHs and separate copies of red-dev, and
 * until now converging one said nothing about the other: `boot.ps1`
 * installed the Windows target and stopped at the boundary, leaving the
 * distro on whatever it had.
 *
 * That is not a hypothetical. A machine converged from Windows to
 * 0.11.0 had a distro still on 0.2.2 with dotfiles from three days
 * earlier, and the terminal — which opens `wsl.exe` — was the one
 * reading the old ones. Nothing failed, nothing was missing, and the
 * feature that had just been installed was simply not there.
 *
 * The wsl scope is the mirror of this, distro reaching out to host, for
 * the terminal and the fonts that live on the Windows side. This is the
 * same boundary crossed the other way, and it belongs to the Windows
 * target for the same reason: whoever is converging owns the crossing.
 *
 * No recursion to worry about. This runs in the desktop scope, native
 * Windows is the only target that gets both desktop and a distro, and
 * what it runs inside is `install core` — a scope that does not contain
 * this step.
 */

import { VERSION } from "./cli.ts";
import { AGENTS } from "./agents.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, type TerminalShell } from "./preferences.ts";
import { spawnLogged } from "./providers.ts";
import { OFFERED_RUNTIMES } from "./runtimes.ts";
import { detectWsl, setWsl2Default, type WslDistribution } from "./wsl-provision.ts";
import { readWindowsOutput } from "./windows-output.ts";

const BOOT_URL = "https://raw.githubusercontent.com/reddb-io/red-dev/main/boot.sh";

/** Commands that reproduce the chosen CLI environment inside WSL. */
export function distroSetupCommands(
  terminalShell: TerminalShell | undefined,
  agentKeys: string[],
  runtimeIds: string[],
): string[] {
  if (terminalShell !== "wsl") return [];

  // Preferences are user-editable JSON and eventually cross a shell
  // boundary. Resolve them against closed catalogs before constructing
  // argv text: unknown data is ignored, never interpolated.
  const knownRuntimes = new Set(OFFERED_RUNTIMES.map((runtime) => runtime.id));
  const runtimes = runtimeIds.filter((id) => knownRuntimes.has(id));
  const cliAgents = agentKeys.filter((key) => {
    const agent = AGENTS.find((candidate) => candidate.key === key);
    return agent !== undefined && !agent.desktopOnly;
  });

  return [
    ...(runtimes.length > 0 ? [`red-dev lang ${runtimes.join(",")}`] : []),
    ...(cliAgents.length > 0 ? [`red-dev agents ${cliAgents.join(",")}`] : []),
  ];
}

/**
 * Reproduce the workstation's selected command-line tools in its WSL distro.
 *
 * Explicit `agents` and `lang` commands make this safe and deterministic:
 * there is no prompt inside the child distro, desktop-only applications are
 * absent from the command, and the Linux-side command never calls back into
 * Windows because this function only runs for a native Windows platform.
 */
export async function syncSelectedTooling(
  p: Platform,
  knownDistro?: WslDistribution,
): Promise<number> {
  if (p.os !== "windows" || process.env["RED_DEV_NO_WSL_SYNC"] === "1") return 0;

  const prefs = await readPreferences(p);
  const commands = distroSetupCommands(
    prefs.terminalShell,
    prefs.agents ?? [],
    prefs.runtimes ?? [],
  );
  if (commands.length === 0) return 0;

  const selected = knownDistro ?? (await defaultDistroInfo());
  if (!selected) {
    log.warn("selected tools were not copied to WSL: no distro is installed");
    return 1;
  }
  if (selected.version !== 2) {
    log.warn(`selected tools were not copied to ${selected.name}: it is not WSL 2`);
    return 1;
  }

  // `lang` and `agents` are public entry points too, not merely the tail
  // of a full desktop converge.  They can therefore reach a distro whose
  // red-dev predates the Windows binary.  Update that binary before asking
  // it to interpret today's runtime/agent choices; otherwise an old child
  // can silently run an old installer (the v2 RedSkills URL was observed
  // here while Windows was already on the v3 contract).
  const bootstrapCode = await ensureDistroRedDev(selected.name);
  if (bootstrapCode !== 0) {
    log.warn(`${selected.name}: updating red-dev failed (${bootstrapCode})`);
    return 1;
  }

  let failures = 0;
  for (const command of commands) {
    log.step(`${selected.name}: ${command}`);
    const code = await spawnLogged([
      "wsl.exe",
      "-d",
      selected.name,
      "--",
      "bash",
      "-lc",
      command,
    ]);
    if (code !== 0) {
      log.warn(`${selected.name}: \`${command}\` failed (${code})`);
      failures++;
    }
  }
  return failures;
}

/** Run a command inside the distro and return its stdout. */
async function inDistro(distro: string, script: string): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["wsl.exe", "-d", distro, "--", "bash", "-lc", script], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = await readWindowsOutput(proc.stdout);
  const code = await proc.exited;
  // A distro's stdout is UTF-8, but a failure notice from wsl.exe itself
  // is UTF-16LE. The boundary decoder handles both without losing text.
  return { out: out.trim(), code };
}

/**
 * Which distro to converge.
 *
 * The default one, which is what `wsl.exe` with no `-d` opens and
 * therefore what the terminal red-dev configures will land in. The
 * verbose listing marks it with `*`, which also lets us verify that it
 * is actually WSL 2 before executing anything inside it.
 */
export async function defaultDistro(): Promise<string | null> {
  return (await defaultDistroInfo())?.name ?? null;
}

/** The default distro and, unlike the legacy quiet listing, its architecture. */
export async function defaultDistroInfo(): Promise<WslDistribution | null> {
  const state = await detectWsl();
  return state.distributions.find((distro) => distro.default) ?? state.distributions[0] ?? null;
}

/** What red-dev the distro has, or null when it has none. */
export async function distroVersion(distro: string): Promise<string | null> {
  // Through a login shell: the binary lands in ~/.local/bin, which is
  // on PATH only once the profile has run.
  const { out, code } = await inDistro(distro, "red-dev --version 2>/dev/null");
  if (code !== 0) return null;
  const line = out.split("\n").pop()?.trim() ?? "";
  return /^\d+\.\d+\.\d+/.test(line) ? line : null;
}

export interface SyncPlan {
  /** Bring the distro's binary up to this one's version first. */
  install: boolean;
  /** Why, in one line, for the log. */
  reason: string;
}

/**
 * What the distro needs, from what it reports.
 *
 * Separated from doing it because this is the part worth testing: the
 * costs are asymmetric. Skipping a needed install leaves exactly the
 * silent drift this step exists to end; installing when nothing changed
 * costs a 99 MB download for nothing.
 */
export function planFor(distroVersion: string | null, ours: string = VERSION): SyncPlan {
  if (distroVersion === null) {
    return { install: true, reason: "no red-dev in the distro" };
  }
  if (distroVersion !== ours) {
    return { install: true, reason: `distro has ${distroVersion}, this is ${ours}` };
  }
  return { install: false, reason: `distro already on ${ours}` };
}

/** Ensure a child distro understands the same contracts as its Windows host. */
async function ensureDistroRedDev(distro: string): Promise<number> {
  const plan = planFor(await distroVersion(distro));
  log.step(`wsl sync: ${distro} — ${plan.reason}`);
  if (!plan.install) return 0;

  // The env prefix goes on `sh`, not on curl: it is the script that
  // must not hand over to the interface, and there is nobody inside
  // the distro to hand over to.
  return spawnLogged([
    "wsl.exe",
    "-d",
    distro,
    "--",
    "bash",
    "-lc",
    `curl -fsSL ${BOOT_URL} | RED_DEV_NO_LAUNCH=1 sh`,
  ]);
}

/**
 * Bring the distro up to this machine's red-dev, converge it, then
 * reproduce the selected command-line tools there.
 *
 * The converge runs whether or not the binary changed. Same version is
 * not the same state — a distro can carry this exact binary and have
 * never run it — and `install core` on a converged distro is a list of
 * `command -v` probes that costs seconds. The expensive case is a distro
 * that needed the work, which is the case worth paying for.
 */
export async function syncWslDistro(p: Platform): Promise<void> {
  if (p.os !== "windows") {
    log.skip("wsl sync: only the Windows side reaches into a distro");
    return;
  }

  if (process.env["RED_DEV_NO_WSL_SYNC"] === "1") {
    log.skip("wsl sync: off (RED_DEV_NO_WSL_SYNC=1)");
    return;
  }

  // Keep future installs on WSL 2 even when there is no distro yet.
  // A failed preference is visible but does not hide the more specific
  // architecture diagnosis below.
  await setWsl2Default();

  const selected = await defaultDistroInfo();
  if (!selected) {
    // Loudly, because "no distro" and "distro left alone" are different
    // states and only one of them is fine.
    log.skip("wsl sync: no WSL distro on this machine");
    return;
  }

  if (selected.version !== 2) {
    const observed = selected.version === 1 ? "WSL 1" : "an unknown WSL version";
    throw new RedError(
      `${selected.name} uses ${observed}; run \`red-dev wsl\` from Windows to migrate it to WSL 2`,
    );
  }

  const distro = selected.name;

  const bootstrapCode = await ensureDistroRedDev(distro);
  if (bootstrapCode !== 0) {
    throw new RedError(`installing red-dev in ${distro} failed (${bootstrapCode})`);
  }

  // Said before the distro's own output arrives, and again after.
  //
  // What runs below is a whole second converge — its own steps, its own
  // counts, its own `— summary —` with its own `failed` line — and
  // spawnLogged pumps every line of it into this run's log. On the
  // converge screen that lands beside the Windows panel's counts, so a
  // machine with two Windows failures and a clean distro showed
  // "Failed: red-skills, nerd-font" on the right and "failed 0" on the
  // left, in one frame. Both were true and nothing said of what.
  log.step(`${distro}: its own converge starts here`);
  const converged = await spawnLogged([
    "wsl.exe",
    "-d",
    distro,
    "--",
    "bash",
    "-lc",
    "red-dev install core",
  ]);
  log.plain(`       ── end of ${distro}; counts above are the distro's, not this run's`);
  if (converged !== 0) {
    // Not fatal to the Windows converge. The most likely cause is sudo
    // wanting a password that no unattended run can supply, and the
    // Windows half of the machine is not wrong because of it.
    log.warn(
      `${distro} did not converge cleanly (${converged}) — ` +
        `run \`red-dev install core\` inside it to see why`,
    );
  } else {
    log.ok(`${distro} converged`);
  }

  const toolingFailures = await syncSelectedTooling(p, selected);
  if (toolingFailures === 0) {
    const prefs = await readPreferences(p);
    if (distroSetupCommands(prefs.terminalShell, prefs.agents ?? [], prefs.runtimes ?? []).length > 0) {
      log.ok(`${distro}: selected CLI tools synchronized`);
    }
  }
}
