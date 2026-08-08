/**
 * What `plan` announces beyond the item list.
 *
 * A module of its own rather than another block inside main.ts, because
 * main.ts ends in `process.exit(await run())` — importing it from a test
 * runs the CLI and takes the process down with it. The announcement that
 * matters most here is the one nobody can check by hand from a Linux
 * machine, so it has to live somewhere a test can call.
 */

import { applicableScopes, describeProvider, itemsNeedingAdmin, providerFor } from "./manifest.ts";
import type { Scope } from "./manifest.ts";
import type { Platform } from "./platform.ts";

/**
 * The items this plan will ask administrator for, ready to print.
 *
 * Read from the manifest's declarations, with nothing executed and no
 * elevation probed: the whole value of saying this during `plan` is that
 * `plan` changes nothing, so an operator can still decide to close the
 * terminal and open an elevated one. Discovering it any later means
 * discovering it at the item that needs the rights — item 36 of 38, half
 * an hour in, with the session already spent.
 *
 * Empty is the answer for every Linux target, and the notice is silent
 * rather than reassuring there. Privileged work on Ubuntu goes through
 * sudo, which already works; a line about administrator would send
 * someone looking for an elevated session that has no equivalent on the
 * machine in front of them.
 */
export function administratorNotice(
  p: Platform,
  scopes: Scope[] = applicableScopes(p),
): string[] {
  const items = itemsNeedingAdmin(p, scopes);
  if (items.length === 0) return [];

  return [
    "\n[administrator]",
    // The same two columns as the item list above, so the rows the
    // operator has just read are the rows being pointed back at.
    ...items.map((t) => `  ${t.name.padEnd(17)}${describeProvider(providerFor(t, p))}`),
    `  ${items.length === 1 ? "this item cannot" : "these items cannot"} complete unelevated — start an elevated session before install`,
  ];
}
