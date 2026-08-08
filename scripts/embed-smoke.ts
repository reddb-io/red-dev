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
import wallpaper from "../assets/wallpapers/obsidian.png" with { type: "file" };
import font from "../assets/fonts/redwall-firacode-subset.ttf" with { type: "file" };

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

// The Redwall font subset, which travels the same way and fails the same
// way. A TTF has no signature as memorable as PNG's: the first four
// bytes are the sfnt version, 0x00010000 for TrueType outlines, and a
// UTF-8 round trip mangles them into something that is still four bytes
// long. Reading a table out of the directory is the cheap way to say the
// file arrived whole rather than merely arrived — cmap is the one the
// subset exists to carry.
const fontBytes = await Bun.file(font).bytes();
const fontView = new DataView(fontBytes.buffer, fontBytes.byteOffset, fontBytes.byteLength);
const sfntOk = fontBytes.length > 12 && fontView.getUint32(0) === 0x00010000;

let tags: string[] = [];
if (sfntOk) {
  const count = fontView.getUint16(4);
  for (let i = 0; i < count; i++) {
    const at = 12 + 16 * i;
    tags.push(String.fromCharCode(...fontBytes.subarray(at, at + 4)));
  }
}

console.log("font path:", basename(font));
console.log("font bytes:", fontBytes.length);
console.log("font sfnt:", sfntOk ? "truetype" : "NOT A TTF");
console.log("font tables:", tags.join(" ") || "none");

if (!sfntOk) {
  console.error("embed-smoke: the font did not survive compilation");
  process.exit(1);
}
for (const required of ["cmap", "glyf", "head", "hmtx", "loca", "maxp"]) {
  if (!tags.includes(required)) {
    console.error(`embed-smoke: the embedded font has no '${required}' table`);
    process.exit(1);
  }
}

console.log("EMBED OK");
