/**
 * Every character Redwall draws.
 *
 * Separate from `redwall-font.ts`, which embeds the subset, and the
 * separation is load-bearing rather than tidy: this file is the *input*
 * to `scripts/vendor-font.ts` and the subset is its *output*. A single
 * module holding both could not be imported by the generator on a tree
 * where the subset has not been cut yet — the `with { type: "file" }`
 * import fails to resolve before the file it names exists — so cutting
 * the font would require the font.
 *
 * Nothing draws yet. What this declares is the contract the later slices
 * inherit: Redwall may write these characters and no others, because the
 * embedded face has glyphs for these and no others.
 */

/**
 * The words the overlay writes, as words.
 *
 * These are the source the character set is derived from, which is the
 * only arrangement that cannot drift. A slice that adds a third label
 * widens the set here, `redwall-font.test.ts` then fails against the
 * committed subset, and the failure says re-vendor — rather than the
 * overlay quietly drawing `.notdef` boxes on somebody's desktop.
 */
export const REDWALL_LABELS = ["WORKERS", "LAN"] as const;

/**
 * Everything the overlay writes that is not a label: the Worker count,
 * the dotted quad, and the colon a port would need. The space is here
 * because a subset without one has nothing to set between two words.
 */
const REDWALL_VALUES = "0123456789.: ";

/**
 * Sorted by codepoint and deduplicated — the order `subsetFont` requires
 * and the order the lock records, so the two can be compared as strings.
 */
export const REDWALL_CHARSET: string = [
  ...new Set([...REDWALL_LABELS.join(""), ...REDWALL_VALUES]),
]
  .sort((a, b) => a.codePointAt(0)! - b.codePointAt(0)!)
  .join("");
