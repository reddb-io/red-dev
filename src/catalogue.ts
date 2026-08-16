/**
 * The Catalogue, and the fact that it reads in both directions.
 *
 * A list of things you can have is half a feature. omakub answers "how
 * do I remove this?" with a second script per application, somewhere
 * else, named after the thing — which means the list you are looking at
 * is not the place you take anything out of, and the only way to know
 * what removing something would do is to read the script. So the tick
 * goes on and stays on, because nothing in the list ever suggested it
 * could come off.
 *
 * Here the untick is the removal. The list a person is already reading
 * is where something leaves from, which makes it a list rather than an
 * install form with a submit button.
 *
 * Two rules hold that up, and both are structural rather than advisory:
 *
 *  - Only `optional` is ever offered. `core`, `desktop` and `wsl` are
 *    the identical-experience layer — the part of the machine nobody
 *    chose and nobody should be able to dismantle with a space bar. They
 *    are not in this file's reach at all, so an untick cannot name one
 *    even by accident, and whole-product removal stays the separate,
 *    explicit act it is (`red-dev uninstall`).
 *  - Nothing goes without being named first. `catalogueRemovals` builds
 *    the list and runs none of it; `removeUnticked` asks once, before
 *    the first removal rather than between them, and returns having done
 *    nothing at all if the answer was no.
 *
 * The removals themselves are not written here. A tool's is the inverse
 * of its provider, which uninstall.ts already derives once for the whole
 * manifest; a web app's is webapps.ts deleting the two files it wrote.
 * This file is the part that decides *which*, and says so out loud.
 */

import { isInstalled, isPresent, providerFor, toolsInScope, type Tool } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { removalFor, type Removal } from "./uninstall.ts";
import type { WebApp, WebAppRow } from "./webapps.ts";

/**
 * The one scope the Catalogue may offer, exported so a test can say so.
 *
 * A constant rather than a literal spelled at each use: the guarantee is
 * that there is exactly one, and three copies of the same string are
 * three places for a fourth to appear.
 */
export const CATALOGUE_SCOPE = "optional" as const;

/** The line a person types to remove what this list will not. */
const THE_OTHER_WAY_OUT = "`red-dev uninstall`";

export interface CatalogueTool {
  tool: Tool;
  /** Usable at the version this machine has — what the install side asks. */
  installed: boolean;
  /**
   * On disk at whatever version — what removal asks, and deliberately
   * not the same question. A tool below its version floor is still the
   * user's to take out; asking `isInstalled` would hide it from the list
   * while leaving it on the machine.
   */
  present: boolean;
  /** How it comes out, or null when nothing here may take it out. */
  removal: Removal | null;
}

/**
 * The optional tools this target can actually have.
 *
 * The scope filter is the guarantee; the provider filter is the honesty.
 * PowerToys is optional everywhere and installable only on Windows, so
 * on Ubuntu it would be a row that does nothing when ticked and names a
 * removal that cannot run when unticked.
 */
export function catalogueTools(p: Platform): CatalogueTool[] {
  const out: CatalogueTool[] = [];
  for (const tool of toolsInScope(CATALOGUE_SCOPE)) {
    if (providerFor(tool, p).kind === "skip") continue;
    // `managed` means the provider owns the layout and nothing probes for
    // it, so `present` is already false — the guard is here to say why
    // rather than to leave the reason to a reader of installState.
    const present = !tool.managed && isPresent(tool);
    out.push({
      tool,
      installed: isInstalled(tool),
      present,
      removal: present ? removalFor(tool, p) : null,
    });
  }
  return out;
}

/** What one line of the Catalogue stands for, once a label comes back. */
export type CatalogueRow =
  | { kind: "tool"; tool: CatalogueTool }
  | { kind: "web"; app: WebApp; installed: boolean }
  | { kind: "add" };

export interface CatalogueLine {
  /**
   * The line the checkbox shows — and the identity it answers with,
   * which is why it is built once and kept. A second construction that
   * drifts by one space is a removal that silently never happens.
   */
  label: string;
  row: CatalogueRow;
  /** Whether the list opens with this one ticked. */
  ticked: boolean;
}

export const ADD_A_WEB_APP = "+ Add a web app by URL…";

/**
 * The whole list, in the order it is drawn.
 *
 * Everything already on the machine opens ticked, in both halves. That
 * is what makes "leaving the list alone changes nothing" true, and it is
 * the precondition for treating an untick as an instruction rather than
 * as the absence of one.
 */
export function catalogueLines(opts: {
  tools: readonly CatalogueTool[];
  webApps: readonly WebAppRow[];
  /** Whether this target has somewhere for a typed-in launcher to live. */
  canAdd: boolean;
}): CatalogueLine[] {
  const lines: CatalogueLine[] = [];

  for (const t of opts.tools) {
    // Every tool opens ticked: a curated list is an opt-out, and the
    // ones that are not installed cost nothing by being on.
    lines.push({ label: toolLabel(t), row: { kind: "tool", tool: t }, ticked: true });
  }

  for (const row of opts.webApps) {
    lines.push({
      label: webAppLabel(row),
      row: { kind: "web", app: row.app, installed: row.installed },
      ticked: row.ticked,
    });
  }

  if (opts.canAdd) {
    lines.push({ label: ADD_A_WEB_APP, row: { kind: "add" }, ticked: false });
  }

  return lines;
}

/**
 * An installed tool this project cannot undo says so on its own row.
 *
 * A vendor script owns its own layout, so `removalFor` refuses to guess
 * which files it wrote — the right answer, and one the list has to
 * repeat, because a row that reads "(installed)" next to five rows an
 * untick removes is a checkbox promising something it will not do.
 */
function toolLabel(t: CatalogueTool): string {
  const about = t.tool.about ? ` — ${t.tool.about}` : "";
  if (!t.present) return `${t.tool.name}${about}`;
  if (!t.removal) return `${t.tool.name}${about}  (installed — ${THE_OTHER_WAY_OUT} removes it)`;
  return `${t.tool.name}${about}  (installed)`;
}

function webAppLabel(row: WebAppRow): string {
  return `${row.app.name} — ${row.app.url || "web app"}${row.installed ? "  (installed)" : ""}`;
}

/** One thing an untick will take out, named the way a person reads it. */
export interface Going {
  name: string;
  /** What goes with it, in the words the confirmation prints. */
  what: string;
  /** Do it. Resolves to what to print once it has. */
  run: () => Promise<string>;
}

/**
 * Everything the answer left unticked that is actually there to remove.
 *
 * Builds closures and calls none of them, so this can be handed to the
 * naming step and thrown away unread if the answer is no.
 */
export function catalogueRemovals(
  lines: readonly CatalogueLine[],
  chosen: ReadonlySet<string>,
  io: { removeWeb: (name: string) => string[] },
): Going[] {
  const going: Going[] = [];

  for (const line of lines) {
    if (chosen.has(line.label)) continue;
    const row = line.row;

    if (row.kind === "tool") {
      // Non-null only for something present that this project knows how
      // to undo, so "installed" and "removable" are one check.
      const removal = row.tool.removal;
      if (!removal) continue;
      going.push({
        name: row.tool.tool.name,
        what: removal.how,
        run: async () => {
          await removal.run();
          return removal.how;
        },
      });
      continue;
    }

    if (row.kind === "web") {
      if (!row.installed) continue;
      going.push({
        name: row.app.name,
        what: "its launcher and its icon",
        run: async () => `${io.removeWeb(row.app.name).length} file(s)`,
      });
    }
  }

  return going;
}

/**
 * The naming step, as lines rather than as printing.
 *
 * Separate from `removeUnticked` on purpose: what a person is told is
 * the thing being promised, so it is a value a test can read rather than
 * a side effect it would have to capture.
 */
export function removalNotice(going: readonly Going[]): string[] {
  return going.map((g) => `${g.name} — ${g.what}`);
}

export interface RemovalOutcome {
  /** Whether the question was answered yes. Nothing ran when it was not. */
  confirmed: boolean;
  /** One line per removal that happened. */
  done: string[];
  failed: { name: string; reason: string }[];
}

/**
 * Ask once, then remove.
 *
 * The question is asked before the first removal rather than per item:
 * a person who has just read the whole list should not be interrogated
 * item by item, and a prompt that appears after two things are already
 * gone is not a confirmation of anything.
 *
 * A failure does not stop the rest. Removing four tools and hitting a
 * held apt lock on the second should not leave two of the four behind
 * with nothing said about them.
 */
export async function removeUnticked(
  going: readonly Going[],
  confirm: (question: string, fallback: boolean) => Promise<boolean>,
): Promise<RemovalOutcome> {
  if (going.length === 0) return { confirmed: false, done: [], failed: [] };

  const question = going.length === 1 ? "Remove it?" : `Remove all ${going.length}?`;
  if (!(await confirm(question, true))) return { confirmed: false, done: [], failed: [] };

  const done: string[] = [];
  const failed: { name: string; reason: string }[] = [];
  for (const g of going) {
    try {
      done.push(`${g.name} removed (${await g.run()})`);
    } catch (err) {
      failed.push({ name: g.name, reason: (err as Error).message });
    }
  }
  return { confirmed: true, done, failed };
}
