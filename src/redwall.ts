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

import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { readHostState } from "./host-state.ts";
import { resolveRedwallAddress } from "./lan-address.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, resolveRedwall } from "./preferences.ts";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import { renderRedwall, type RedwallState } from "./redwall-render.ts";
import { resolveThemeSlug, THEMES } from "./themes.ts";
import { imageRoot, shortDigest, wallpaperBytes, wallpaperPathInUse } from "./wallpaper.ts";

/** Where the generated images live. A sibling of `wallpapers/`, never inside it. */
export async function redwallDir(p: Platform): Promise<string> {
  return `${await imageRoot(p)}/redwall`;
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
}

/**
 * What this machine currently says about itself.
 *
 * Both halves are asked at once and neither can withhold the other: a
 * daemon that is not running costs the Worker count, and `host-state.ts`
 * turns every way that can happen into `null` rather than a throw. The
 * address is resolved without the daemon's help precisely so that it
 * survives.
 */
export async function redwallState(p: Platform): Promise<RedwallState> {
  const [host, address] = await Promise.all([readHostState(), resolveRedwallAddress(p)]);
  return { workers: host?.workers ?? null, address };
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
): Promise<RedwallOutcome> {
  if (!(await resolveRedwall(p))) return skipped("off");
  // Not a failure, and not a thing to warn about either: a server is a
  // machine that never had a desktop to write on.
  if (p.env === "server") return skipped("headless");

  // Through resolveThemeSlug, so a machine still carrying one of the
  // retired slugs draws its Redwall on the art it is actually themed
  // with rather than failing to find a wallpaper for a name nothing
  // holds any more.
  const slug = resolveThemeSlug((await readPreferences(p)).theme);
  const state = await (seams.state ?? (() => redwallState(p)))();

  const bytes = renderRedwall({
    art: await wallpaperBytes(slug),
    font: await Bun.file(REDWALL_SUBSET).bytes(),
    theme: THEMES[slug],
    state,
  });

  const dir = await redwallDir(p);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${slug}-${shortDigest(bytes)}.png`;

  // The skip is the point, not an optimisation: rewriting identical
  // bytes would move the file's timestamp, and a hook that fires on
  // every tick would leave a directory that looks freshly churned on a
  // machine where nothing changed.
  const written = !existsSync(path);
  if (written) await Bun.write(path, bytes);

  const removed = await sweepSupersededRedwalls(p, path, seams.inUse);
  return { path, skipped: null, written, removed };
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

  const displayed = await currentlyDisplayed(p, inUse);
  const removed: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".png")) continue;
    const path = `${dir}/${name}`;
    if (samePath(path, keep) || samePath(path, displayed)) continue;
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
 * Null, not an empty list, when there was nothing here. Redwall is off
 * by default, so "this machine never generated one" is the common
 * answer and has to read as success rather than as a thing that failed
 * to happen.
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
