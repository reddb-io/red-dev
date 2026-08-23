/**
 * Generate the Redwall and put it where the machine that displays it can
 * read it.
 *
 * `redwall-render.ts` is the pure half: art plus state in, PNG bytes
 * out, no disk and no daemon. This is the half with effects — it asks
 * the daemon what it knows, asks the routing table where this machine
 * answers, hands both to the renderer, and writes the result down. The
 * split is what lets every claim about the image be tested without a
 * desktop, and it is why nothing in here decides what the overlay looks
 * like.
 *
 * ## Why a directory of its own
 *
 * Not `wallpapers/`. The wallpapers are immutable per theme and named
 * after their contents, and `expectedWallpaperNames()` is the finite set
 * that lets the sweep say "red-dev wrote this and no longer would" about
 * one file and "somebody chose this" about another. A Redwall changes
 * whenever the state it draws changes, so a Redwall in that directory
 * would make the expected set unbounded — and an unbounded expected set
 * is no set at all: the sweep would either delete a wallpaper someone
 * picked by hand or stop deleting anything.
 *
 * The two directories are siblings under one root, so the rule about
 * where images live on a WSL machine is stated once, in `wallpaper.ts`,
 * and both obey it.
 *
 * ## Why the name carries a digest
 *
 * The same reason the wallpapers do, and it matters more here. GNOME
 * repaints when `picture-uri` changes, not when the bytes behind an
 * unchanged URI change; a fixed filename would leave the desktop showing
 * last hour's Worker count with the right image sitting on disk. New
 * bytes are a new path, so there is no cache to invalidate.
 *
 * It also makes the run cheap in the case that will be the common one.
 * A hook that fires on every state change fires often, and most of those
 * changes are invisible to a Redwall — the file name is a function of
 * the bytes, so an unchanged Redwall is an `existsSync` and nothing
 * else. That is what makes running this twice on unchanged state leave
 * the directory exactly as it was.
 *
 * ## Why it sweeps
 *
 * Because a derived image with a content-addressed name accumulates. Six
 * wallpapers are six files forever; a Worker count that moves between 0
 * and 8 through a working day is a new 4K PNG every time it moves. So
 * the images this generation superseded go, and the one the desktop is
 * currently pointed at is spared — deleting the file the OS has open is
 * how you get a black desktop for the moment between the delete and the
 * next apply.
 *
 * ## Doing nothing, successfully
 *
 * With the preference off this writes nothing and reports success. The
 * trigger — a RedSkills hook, and later `red-dev theme` — must not have
 * to know whether the feature is enabled, and a non-zero exit for "the
 * user did not ask for this" would turn an ordinary state into an error
 * in somebody's logs. A headless machine is the same answer for the same
 * reason: nothing there will ever display it.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { agentUsageReading, agentUsageSnapshot, type AgentUsageReading } from "./agent-usage.ts";
import {
  githubRatePercent,
  mergeGithubCredentialRates,
  readGithubRateLimit,
  readRedskilledGithubRates,
  readWindowsWslGithubRates,
} from "./github-rate.ts";
import { mergeHostStates, readHostState, readWindowsWslHostState } from "./host-state.ts";
import { resolveRedwallAddress, spawnCapture } from "./lan-address.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, resolveRedwall } from "./preferences.ts";
import { renderRedwallViaBin } from "./redwall-bin.ts";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import { readPackageSetState } from "./red-skills-set.ts";
import { renderRedwall, yearProgress, type RedwallState } from "./redwall-render.ts";
import { resolveThemeSlug } from "./themes.ts";
import { hiddenCapture, hiddenPowershell } from "./windows-hidden.ts";
import {
  imageRoot,
  resolveWallpaperArt,
  setDesktopBackground,
  setLockScreenBackground,
  shortDigest,
  wallpaperPathInUse,
} from "./wallpaper.ts";

/** Where the generated images live. A sibling of `wallpapers/`, never inside it. */
export async function redwallDir(p: Platform): Promise<string> {
  return `${await imageRoot(p)}/redwall`;
}

/**
 * What red-dev last managed to put on this machine's desktop.
 *
 * A file rather than a question asked of the OS, and that distinction is
 * the whole of why the timer stopped flashing a console window every two
 * minutes. Asking Windows what it is displaying costs a PowerShell
 * launched through interop, and repainting costs another — on the tick
 * where nothing has changed, which is nearly every tick, both are spent
 * to learn that the desktop is already showing exactly the file red-dev
 * would have put there.
 *
 * Beside the images, without a `.png` on the end so the sweep next door
 * walks past it, and inside the directory `removeRedwall` takes away
 * whole — a record of a Redwall must not outlive the Redwalls.
 */
const SHOWN_RECORD = "shown";

/** The exact bytes of that record. PURE. */
export function redwallRecord(path: string): string {
  return [
    "# Managed by red-dev — the Redwall last put on this machine's desktop.",
    "# Delete this file to have the next run repaint whatever it finds.",
    path,
    "",
  ].join("\n");
}

async function readShownRedwall(p: Platform): Promise<string | null> {
  try {
    const path = `${await redwallDir(p)}/${SHOWN_RECORD}`;
    if (!existsSync(path)) return null;
    const body = readFileSync(path, "utf8");
    return body.split("\n").map((line) => line.trim())
      .find((line) => line !== "" && !line.startsWith("#")) ?? null;
  } catch {
    // A record that cannot be read is a record that says nothing, which
    // costs a repaint and never a wrong one.
    return null;
  }
}

async function recordShownRedwall(p: Platform, path: string): Promise<void> {
  writeFileSync(`${await redwallDir(p)}/${SHOWN_RECORD}`, redwallRecord(path));
}

/** Why nothing was generated, when nothing was. */
export type RedwallSkip =
  /** The preference is off, which is its default. */
  | "off"
  /** No desktop here, so no surface to show it on. */
  | "headless";

export interface RedwallOutcome {
  /** Where the image is, or null when none was generated. */
  readonly path: string | null;
  /** Null when an image was generated. */
  readonly skipped: RedwallSkip | null;
  /** False when those exact bytes were already on disk under that name. */
  readonly written: boolean;
  /** Names of the superseded images removed once the new one had landed. */
  readonly removed: string[];
}

/**
 * The seams a test replaces, and the two things this module asks the
 * machine about that a build server cannot answer.
 *
 * Both defaults reach for a process — `redskilled`, `ip`, `gsettings` —
 * so a test that did not replace them would assert against whatever the
 * machine running CI happened to be. Injected here rather than deeper,
 * because "what does this machine say about itself" is exactly the
 * question this module exists to ask, and the layers below already have
 * their own seams for their own halves of it.
 */
export interface RedwallSeams {
  /** What to draw. Defaults to asking the daemon and the routing table. */
  readonly state?: () => Promise<RedwallState>;
  /** Which image the desktop is pointed at, so the sweep can spare it. */
  readonly inUse?: () => Promise<string | null>;
  /**
   * Where the finished image goes. Defaults to `showRedwall`, which is
   * every screen this machine has rather than only the desktop.
   */
  readonly show?: (path: string) => Promise<boolean>;
  /** The local civil day drawn in the year-progress calendar. */
  readonly now?: () => Date;
}

/**
 * The provider whose allowance a Redwall draws.
 *
 * One, and it is the one `agent-usage.ts` has a cheap read path for. A
 * second provider here would be a second unknown line on every desktop
 * that does not use it, which is noise rather than a reading.
 */
const AGENT_USAGE_PROVIDER = "claude";

/**
 * The agent allowance, read and never collected.
 *
 * This is the whole of what a repaint may do about agent usage: open a
 * file that some other run wrote, or find none. It does not authenticate,
 * does not reach the network, does not take the collector's lock and
 * never starts a process — a wallpaper regenerates every two minutes on a
 * timer, and a repaint that could collect would be a probe on that
 * cadence forever. An absent, malformed or aged-out snapshot is `null`,
 * which the overlay draws as unknown.
 *
 * The path is injectable so a test can hand it a fixture without writing
 * into the operator's own state directory.
 */
export function redwallAgentUsage(
  options: { readonly path?: string; readonly nowMs?: number } = {},
): AgentUsageReading | null {
  const snapshot = agentUsageSnapshot({
    provider: AGENT_USAGE_PROVIDER,
    ...(options.path === undefined ? {} : { path: options.path }),
  });
  return agentUsageReading(snapshot, options.nowMs ?? Date.now());
}

/**
 * What this machine currently says about itself.
 *
 * Daemon state and address are asked at once and neither can withhold the
 * other: a daemon that is not running costs its operational facts, and
 * `host-state.ts` turns every way that can happen into `null` rather than a
 * throw. The address is resolved without the daemon's help so it survives.
 */
export async function redwallState(p: Platform): Promise<RedwallState> {
  const [host, address, redskilledGithub] = await Promise.all([
    p.os === "windows"
      ? Promise.all([readHostState(), readWindowsWslHostState()]).then(mergeHostStates)
      : readHostState(),
    redwallAddress(p),
    p.os === "windows"
      ? Promise.all([readRedskilledGithubRates(), readWindowsWslGithubRates()]).then(mergeGithubCredentialRates)
      : readRedskilledGithubRates(),
  ]);
  // The daemon already paid to learn this answer. Only installations from
  // before its identity-labelled history ask `gh` themselves as a fallback.
  const githubRate = redskilledGithub?.pat ? null : await readGithubRateLimit();
  const fallbackPat = githubRate === null
    ? null
    : { api: githubRatePercent(githubRate.core), graphql: githubRatePercent(githubRate.graphql) };
  return {
    workers: host?.workers ?? null,
    capacity: host?.capacity ?? null,
    queued: host?.queued ?? null,
    attention: host?.attention ?? null,
    github: redskilledGithub === null && fallbackPat === null
      ? null
      : {
        pat: redskilledGithub?.pat ?? fallbackPat,
        app: redskilledGithub?.app ?? null,
      },
    // Always present, so the card carries the reading or says it has
    // none. Omitting it on a machine with no snapshot would be a Redwall
    // that looks the same whether the allowance is untouched or unknown.
    agent: redwallAgentUsage(),
    // This machine's own set, not a merged one. On Windows the card
    // reports Workers from every distro together, and that is right for
    // a count — but a *version* is a fact about one installation, and
    // averaging two of them would name a revision that exists nowhere.
    version: activeSetVersion(),
    address,
  };
}

/**
 * The RedSkills version this machine resolves, or null.
 *
 * Read from the package-set state rather than asked of the daemon: the
 * daemon reports what it is *doing*, and `redskilled` is installed out
 * of the set, so red-dev already knows which revision it came from. One
 * file read, no subprocess — this runs on every repaint.
 */
function activeSetVersion(): string | null {
  try {
    const home = (process.env["HOME"] ?? process.env["USERPROFILE"] ?? "").replace(/\\/g, "/");
    const state = readPackageSetState(home);
    return state.revisions.find((revision) => revision.key === state.active)?.version ?? null;
  } catch {
    // A machine with no set yet draws the name alone, which is true.
    return null;
  }
}

/**
 * This machine's address, asked without putting a window on the screen.
 *
 * On WSL the question can only be answered by the host — the distro sees
 * a NAT address nobody else can reach — so it is a PowerShell across the
 * boundary, and from a systemd timer that is a console window allocated
 * for it. Every other target answers from inside itself, so only WSL
 * pays for the indirection.
 *
 * A shape `hiddenPowershell` does not recognise falls through to the
 * ordinary spawn rather than to nothing: an address that is drawn with a
 * window flashing beats a Redwall that stops naming the machine.
 */
async function redwallAddress(p: Platform): Promise<string | null> {
  if (p.env !== "wsl") return await resolveRedwallAddress(p);

  const dir = await imageRoot(p);
  return await resolveRedwallAddress(p, async (cmd) => {
    const command = hiddenPowershell(cmd);
    if (command === null) return await spawnCapture(cmd);
    return await hiddenCapture(dir, command, p);
  });
}

/**
 * Compose this machine's Redwall and write it, or explain why it did
 * not.
 *
 * Everything that can be answered without doing work is answered first:
 * the preference, then the target. Only then does anything read a
 * daemon, spawn a route lookup, or touch a 4K PNG.
 */
export async function generateRedwall(
  p: Platform,
  seams: RedwallSeams = {},
  /**
   * The theme to draw on, for a caller that already knows which one.
   *
   * A theme switch is exactly that caller, and it needs this: `red-dev
   * theme` does not record the new slug before it applies it, so a
   * Redwall that only ever read the preference would draw the machine's
 * state over the art the user just switched away from. Omitted, the
 * recorded preference is the answer — which is what the hook, firing
   * on a state change rather than a theme change, has to fall back on.
   */
  theme?: string,
  /** Explicit art choice during a switch; undefined reads the recorded preference. */
  wallpaper?: string | null,
): Promise<RedwallOutcome> {
  if (!(await resolveRedwall(p))) return skipped("off");
  // Not a failure, and not a thing to warn about either: a server is a
  // machine that never had a desktop to write on.
  if (p.env === "server") return skipped("headless");

  const prefs = await readPreferences(p);
  const colourSlug = resolveThemeSlug(theme ?? prefs.theme ?? "");
  const art = await resolveWallpaperArt(
    p,
    colourSlug,
    wallpaper === undefined ? prefs.wallpaper : wallpaper,
  );
  const state = await (seams.state ?? (() => redwallState(p)))();

  const fontBytes = readFileSync(REDWALL_SUBSET);
  const stateForBin: Record<string, unknown> = {
    workers: state.workers,
    version: state.version,
    address: state.address,
    capacity: state.capacity,
    queued: state.queued,
  };

  // Prefer the scriptc-compiled binary when one is reachable: 1.8 MB on
  // disk, ~4 MB resident, ~10 ms cold-start. Falls through to the
  // in-process renderer if the binary is missing or fails.
  const binBytes = await renderRedwallViaBin({
    state: stateForBin,
    themeSlug: colourSlug,
  });
  const bytes = binBytes ?? renderRedwall({
    art: art.bytes,
    font: fontBytes,
    theme: art.theme,
    state,
    year: yearProgress((seams.now ?? (() => new Date()))()),
  });

  const dir = await redwallDir(p);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${art.key}-${shortDigest(bytes)}.png`;

  // The skip is the point, not an optimisation: rewriting identical
  // bytes would move the file's timestamp, and a hook that fires on
  // every tick would leave a directory that looks freshly churned on a
  // machine where nothing changed.
  const written = !existsSync(path);
  if (written) writeFileSync(path, bytes);

  const removed = await sweepSupersededRedwalls(p, path, seams.inUse);
  return { path, skipped: null, written, removed };
}

export interface RedwallApplied extends RedwallOutcome {
  /** Whether the desktop is now pointed at the image. */
  readonly shown: boolean;
}

/** The screens a Redwall reaches, replaceable one at a time. */
export interface ScreenWriters {
  /** The desktop, which is what `shown` means. */
  readonly desktop?: (path: string) => Promise<boolean>;
  /** The lock screen, where a target has one red-dev can write. */
  readonly lock?: (path: string) => Promise<boolean>;
}

/**
 * Put the image on every screen this machine has, and report the desktop.
 *
 * The lock screen is the surface that motivated the whole feature: a
 * Worker count and an address are worth reading without unlocking, and a
 * Redwall only the person already sitting at an unlocked machine can see
 * is showing state to the one person who does not need it.
 *
 * It is written after the desktop and its answer is dropped, which is the
 * whole of the tolerance this needs. The lock-screen key is not on every
 * target — GNOME has it, Windows has nothing red-dev should write — and a
 * machine that lacks it has still had its desktop repainted, so folding
 * that absence into `shown` would report a successful apply as a failure
 * and leave a caller retrying a surface that does not exist. `shown` is a
 * claim about the desktop, and stays one.
 *
 * Both writers are injectable because the defaults repaint the screens of
 * whoever runs the suite. Injected here rather than as two more seams on
 * `applyRedwall`: a test that replaced only `show` would otherwise leave
 * the lock-screen default live and reach for `gsettings` anyway, which is
 * exactly the accident this seam exists to prevent.
 */
export function showRedwall(
  p: Platform,
  writers: ScreenWriters = {},
): (path: string) => Promise<boolean> {
  return async (path: string): Promise<boolean> => {
    const shown = await (writers.desktop ?? ((image: string) => setDesktopBackground(image, p)))(
      path,
    );
    await (writers.lock ?? ((image: string) => setLockScreenBackground(image, p)))(path);
    return shown;
  };
}

/**
 * Compose this machine's Redwall for a theme and put it on the screens.
 *
 * The two halves are one call because they are useless apart. Generating
 * without showing leaves a 4K PNG nothing points at; showing without
 * generating first would point the desktop at the previous theme's
 * overlay. `generateRedwall` stays separate underneath it because the
 * hook that fires on a state change wants the first half testable
 * without a desktop, and because `red-dev redwall` reports the path.
 *
 * It sweeps a second time, and that is the point of doing both halves in
 * one place. The sweep inside `generateRedwall` necessarily runs before
 * the desktop is repointed, so it has to spare the image on screen — and
 * on a theme switch the image on screen is precisely the one being
 * replaced. Left there, a user trying the six themes in turn keeps a 4K
 * PNG for every theme but the first. Once the desktop has moved, the
 * same sweep spares the new image instead and the old one goes, which is
 * the ordering `sweepRetiredWallpapers` has always kept next door.
 */
export async function applyRedwall(
  p: Platform,
  theme: string,
  seams: RedwallSeams = {},
  wallpaper?: string | null,
): Promise<RedwallApplied> {
  const outcome = await generateRedwall(p, seams, theme, wallpaper);
  if (outcome.path === null) return { ...outcome, shown: false };

  // The tick that happens over and over, answered without touching the
  // machine. Two facts and no processes: these bytes were already on
  // disk under this name, and this is the file red-dev last saw land on
  // the desktop — so the desktop is already showing it, and repainting
  // would spend a PowerShell to produce no change at all. On WSL that
  // PowerShell is launched through interop from a systemd unit with no
  // console, which is a window on somebody's screen every two minutes.
  //
  // The tradeoff is stated rather than hidden: a user who changes their
  // wallpaper by hand is not noticed until the Redwall's own bytes
  // change, which on a working machine is minutes and on an idle one
  // could be hours. That is the deliberate side to be wrong on — the
  // alternative is asking the registry every two minutes, forever, to
  // undo a choice the user just made on purpose. `doctor` still asks the
  // live question, and `red-dev redwall` after deleting the record
  // repaints at once.
  if (!outcome.written && (await readShownRedwall(p)) === outcome.path) {
    return { ...outcome, shown: true };
  }

  const show = seams.show ?? showRedwall(p);
  const shown = await show(outcome.path);
  // Only when the repaint took. A desktop that refused is still pointed
  // at the previous Redwall, and that file is not this run's to remove.
  if (!shown) return { ...outcome, shown };

  // After the repaint and never before it: a record written ahead of a
  // repaint that then failed would short-circuit every following tick
  // against a desktop that never received the image.
  await recordShownRedwall(p, outcome.path);

  const removed = await sweepSupersededRedwalls(p, outcome.path, seams.inUse);
  return { ...outcome, removed: [...outcome.removed, ...removed], shown };
}

/**
 * Delete the Redwalls this one replaced.
 *
 * Only inside red-dev's own Redwall directory, and only after the new
 * image is on disk — the same ordering `sweepRetiredWallpapers` keeps,
 * for the same reason. `keep` is the image just written; the image the
 * desktop is currently pointed at is spared as well, because removing
 * what the OS has a handle on is how a desktop goes black in the gap
 * before something repoints it.
 *
 * A machine that cannot say what it is displaying spares nothing. That
 * is the deliberate choice: the cost is a moment of black on a desktop
 * that was about to be repainted anyway, and the alternative — never
 * sweeping when the question cannot be answered — is a directory of 4K
 * PNGs that grows for as long as the machine works.
 */
export async function sweepSupersededRedwalls(
  p: Platform,
  keep: string,
  inUse: (() => Promise<string | null>) | undefined = undefined,
): Promise<string[]> {
  const dir = await redwallDir(p);
  if (!existsSync(dir)) return [];

  const candidates = readdirSync(dir)
    .filter((name) => name.endsWith(".png") && !samePath(`${dir}/${name}`, keep));
  // Asked only when there is something the answer could save. The probe
  // exists to spare the file on screen from deletion, so with nothing to
  // delete it can only ever spare nothing — and on WSL it costs a
  // PowerShell through interop, which on a two-minute timer is a console
  // window flashing over the wallpaper it was asked about. This is the
  // steady state: one image in the directory, and it is the keeper.
  if (candidates.length === 0) return [];

  const displayed = await currentlyDisplayed(p, inUse);
  const removed: string[] = [];
  for (const name of candidates) {
    const path = `${dir}/${name}`;
    if (samePath(path, displayed)) continue;
    rmSync(path, { force: true });
    removed.push(name);
  }
  return removed;
}

/**
 * Delete the whole Redwall directory, and report whether there was one.
 *
 * Uninstall's half of the sweep above. The sweep spares the image on
 * screen because something is about to replace it; here nothing is, and
 * a desktop pointed at a file red-dev is removing is the state the user
 * asked for — the alternative is leaving a 4K PNG behind to keep an
 * unowned wallpaper setting company.
 *
 * The directory rather than its `.png` files, because an empty
 * `redwall/` under a removed tool's root is still a trace of the
 * feature, and unlike the sweep there is no next generation that needs
 * somewhere to land. Nothing outside it is touched: the sibling
 * `wallpapers/` is a different directory with a different owner, and a
 * wallpaper somebody chose by hand is a decision that outlives the tool
 * uninstalled around it.
 *
 * Null, not an empty list, when there was nothing here. A machine can
 * opt out before ever generating one, and that ordinary state has to
 * read as success rather than as a thing that failed to happen.
 */
export async function removeRedwall(p: Platform): Promise<string | null> {
  const dir = await redwallDir(p);
  if (!existsSync(dir)) return null;
  rmSync(dir, { recursive: true, force: true });
  return dir;
}

async function currentlyDisplayed(
  p: Platform,
  inUse: (() => Promise<string | null>) | undefined,
): Promise<string | null> {
  try {
    return await (inUse ?? (() => wallpaperPathInUse(p)))();
  } catch {
    // The OS was asked and did not answer. Same as "nothing is
    // displayed" for this purpose, and never worth failing a
    // regeneration over.
    return null;
  }
}

/**
 * Whether two paths name the same file, as far as this comparison needs
 * to be right.
 *
 * Windows is why this is not `===`. This module joins with `/` and the
 * registry answers with `\`, and the drive letter's case is not the
 * file's identity either — so the one place the sweep must not get a
 * false "different" is exactly the one where a naive compare gives one,
 * and the file it would then delete is the one on screen.
 */
function samePath(a: string, b: string | null): boolean {
  if (b === null) return false;
  const normalise = (value: string): string => value.replace(/\\/g, "/").toLowerCase();
  return normalise(a) === normalise(b);
}

function skipped(reason: RedwallSkip): RedwallOutcome {
  return { path: null, skipped: reason, written: false, removed: [] };
}
