/**
 * Render every theme's wallpaper into assets/wallpapers/.
 *
 * The binary generates these at apply time too, so this is not on the
 * install path. It exists so the images are committed, reviewable in a
 * diff, and usable by anyone who wants the file without running the
 * tool.
 *
 *   bun run scripts/generate-wallpapers.ts
 */

import { mkdirSync } from "node:fs";
import { THEMES } from "../src/themes.ts";
import { renderWallpaper } from "../src/wallpaper.ts";

const OUT = `${import.meta.dir}/../assets/wallpapers`;
mkdirSync(OUT, { recursive: true });

for (const [key, theme] of Object.entries(THEMES)) {
  const png = renderWallpaper(theme);
  const path = `${OUT}/${key}.png`;
  await Bun.write(path, png);
  console.log(`${key.padEnd(14)} ${(png.length / 1024).toFixed(0)} KB  ${theme.name}`);
}
