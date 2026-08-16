/**
 * Learn — where the documentation is, from inside the program.
 *
 * The README is sixty kilobytes and answers almost everything, which is
 * exactly the problem: nobody reads it from the top, and the person who
 * needs the troubleshooting section is the person least likely to be
 * looking at a browser. So the menu carries the README by anchor —
 * named sections, each a link to that heading — rather than one "docs"
 * entry pointing at the front of a long page.
 *
 * Three kinds of thing, and the third is the point. The README sections
 * and RedSkills are elsewhere; the keys viewer is here, in this program,
 * and listing it beside them is what makes Learn a place to find out how
 * red-dev works rather than a bookmark folder. It is also the honest
 * answer to "which key does X" — a link cannot answer that for the
 * machine you are on, and the viewer can.
 *
 * Flat, deliberately. ADR 0006's neighbour decision was that the menu
 * grows by sections rather than by Omarchy's tree, and a Learn submenu
 * of submenus is the first place a tree would grow back.
 */

import type { Platform } from "./platform.ts";

/** The repository, whose front page renders the README with its anchors. */
const README = "https://github.com/reddb-io/red-dev";

/**
 * The heading text, exactly as the README spells it.
 *
 * Exactly, because the anchor is derived from it and a link to a
 * heading that has been renamed is a link to the top of the page — a
 * failure with no error, which is why learn.test.ts reads the README
 * and checks that each of these is still a heading in it.
 */
const README_SECTIONS: readonly { key: string; heading: string; detail: string }[] = [
  { key: "quick-start", heading: "Quick start", detail: "the one-liner, and what it does first" },
  { key: "usage", heading: "Usage", detail: "every command, on one screen" },
  {
    key: "targets",
    heading: "Using it on each target",
    detail: "Ubuntu, WSL and Windows, and what differs",
  },
  { key: "themes", heading: "Themes", detail: "the palettes, and what they reach" },
  { key: "troubleshooting", heading: "Troubleshooting", detail: "when the machine disagrees" },
  { key: "under-the-hood", heading: "Under the hood", detail: "how a converge is put together" },
];

/**
 * GitHub's anchor for a heading: folded, punctuation dropped, spaces
 * hyphenated.
 *
 * Derived rather than written down beside each heading, so the two
 * cannot drift apart while both look right.
 */
export function anchor(heading: string): string {
  // Space by space rather than run by run: GitHub drops the punctuation
  // and hyphenates what is left where it stands, so `Themes & colour`
  // is `themes--colour` and a tidier collapse here would produce an
  // anchor that looks right and matches nothing.
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");
}

export interface LearnEntry {
  /** Stable, because the menu stores it. */
  key: string;
  label: string;
  /** One line, read after the label. */
  detail: string;
  /** Where it leads, or null when it opens a surface of red-dev's own. */
  url: string | null;
}

export const LEARN: readonly LearnEntry[] = [
  ...README_SECTIONS.map((section) => ({
    key: `readme.${section.key}`,
    label: `README — ${section.heading}`,
    detail: section.detail,
    url: `${README}#${anchor(section.heading)}`,
  })),
  {
    key: "red-skills",
    label: "RedSkills",
    detail: "the skills red-dev wires into every agent host",
    url: "https://github.com/reddb-io/red-skills",
  },
  {
    // Last, and in the list rather than beside it: someone who came to
    // Learn to find out how something works is one row away from the
    // answer for the machine they are on.
    key: "keys",
    label: "Keys — the searchable viewer",
    detail: "every action, its chord, and whether this machine binds it",
    url: null,
  },
];

/** The list as text, for a terminal with no interface to draw. */
export function learnLines(entries: readonly LearnEntry[] = LEARN): string[] {
  const width = entries.reduce((max, e) => Math.max(max, e.label.length), 0);
  return entries.map(
    (entry) => `${entry.label.padEnd(width)}  ${entry.url ?? "red-dev keys"}  — ${entry.detail}`,
  );
}

/**
 * How this target opens a link, or nothing when it cannot.
 *
 * Null is a real answer, not a failure: a headless server has no browser
 * to hand a URL to, and printing the URL there is more useful than
 * spawning something that will not work. The Windows idiom is the shell
 * launcher for the same reason the terminal action uses it — it works
 * identically from Windows and from inside WSL.
 */
export function browseArgv(
  url: string,
  p: Platform,
  locate: (cmd: string) => string | null,
): string[] | null {
  if (p.env === "windows" || p.env === "wsl") return ["cmd.exe", "/c", "start", "", url];
  if (p.env === "desktop" && locate("xdg-open") !== null) return ["xdg-open", url];
  return null;
}
