/**
 * Smoke test: do text imports survive `bun build --compile`?
 *
 * The dotfiles have to travel inside the binary — a machine that only
 * downloaded an executable has no repository to read config/ from. If
 * import attributes do not survive compilation, the whole distribution
 * story needs a different answer, so this is checked before anything
 * depends on it.
 */

import rc from "../config/bash/rc.sh" with { type: "text" };
import aliases from "../config/bash/aliases.sh" with { type: "text" };

console.log("rc.sh bytes:", rc.length);
console.log("aliases.sh bytes:", aliases.length);
console.log("rc first line:", rc.split("\n")[0]);
console.log(
  "aliases mentions batcat:",
  aliases.includes("batcat") ? "yes" : "no",
);
console.log("EMBED OK");
