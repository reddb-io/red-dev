/**
 * Smoke test: do imports survive `bun build --compile`?
 *
 * The dotfiles have to travel inside the binary — a machine that only
 * downloaded an executable has no repository to read config/ from. If
 * import attributes do not survive compilation, the whole distribution
 * story needs a different answer, so this is checked before anything
 * depends on it.
 *
 * Two mechanisms, because they behave differently and only one of them
 * was ever proved here. `type: "text"` decodes UTF-8 and yields the
 * contents. `type: "file"` yields a *path* — a real one under `bun run`,
 * one into the executable's embedded blobs under `--compile` — which is
 * the only way a PNG can travel: put a PNG through the text form and it
 * comes back mangled, silently, with a plausible length.
 */

import { basename } from "node:path";
import rc from "../config/bash/rc.sh" with { type: "text" };
import aliases from "../config/bash/aliases.sh" with { type: "text" };
import wallpaper from "../assets/wallpapers/tokyo-night.png" with { type: "file" };

console.log("rc.sh bytes:", rc.length);
console.log("aliases.sh bytes:", aliases.length);
console.log("rc first line:", rc.split("\n")[0]);
console.log(
  "aliases mentions batcat:",
  aliases.includes("batcat") ? "yes" : "no",
);

// The bytes, not the length. A truncated or UTF-8-mangled PNG still has
// a length; only the signature says the blob survived intact.
const bytes = await Bun.file(wallpaper).bytes();
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const signatureOk = SIGNATURE.every((b, i) => bytes[i] === b);

console.log("wallpaper path:", basename(wallpaper));
console.log("wallpaper bytes:", bytes.length);
console.log("wallpaper signature:", signatureOk ? "png" : "NOT A PNG");

if (!signatureOk) {
  console.error("embed-smoke: the PNG did not survive compilation");
  process.exit(1);
}
if (bytes.length < 1024) {
  console.error(`embed-smoke: the PNG is ${bytes.length} bytes, which is not a wallpaper`);
  process.exit(1);
}

console.log("EMBED OK");
