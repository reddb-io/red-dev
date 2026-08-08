/**
 * The font Redwall draws with, embedded.
 *
 * Nothing draws with it yet. This slice puts the asset in the binary and
 * pins where it came from, so the slices that follow can rasterise
 * without also having to answer a licensing question halfway through.
 *
 * Why a font travels in the binary at all: Spec #52 requires Redwall to
 * render identically on a machine whose owner picked a different
 * terminal font. Reading the installed FiraCode would make the overlay
 * depend on a font install that red-dev offers but does not require, and
 * on Windows on a face the distro cannot see. The same argument
 * `src/wallpaper.ts` makes about the images: the asset is in the binary
 * or the build is broken, and `scripts/embed-smoke.ts` fails the build
 * first.
 *
 * `with { type: "file" }` yields a PATH rather than the bytes — see
 * src/shims.d.ts. Under --compile Bun also renames the embedded file, so
 * the basename differs between `bun run` and the binary and must never
 * be used to derive anything.
 *
 * The character set this face covers is declared in
 * `redwall-charset.ts`, which is deliberately not this file — see the
 * note there.
 */

import subset from "../assets/fonts/redwall-firacode-subset.ttf" with { type: "file" };

/** Path to the embedded subset, for `Bun.file()`. */
export const REDWALL_SUBSET: string = subset;
