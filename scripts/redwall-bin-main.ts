/**
 * Standalone Redwall entrypoint compiled with scriptc.
 *
 * Lives in `scripts/` because it is only used by the scriptc build, not
 * by the Bun-compiled `red-dev`. `scripts/build-redwall-bin.sh` copies
 * this file into the build directory beside the renderer sources, where
 * the relative `./redwall-render.ts` imports resolve to the vendored
 * copies (which themselves have been tweaked for scriptc compatibility).
 *
 * Inputs (env):
 *   REDWALL_OUT     — output PNG path; empty writes to stdout
 *   REDWALL_THEME   — theme slug (default: obsidian)
 *   REDWALL_WORKERS, REDWALL_VERSION, REDWALL_ADDRESS,
 *   REDWALL_CAPACITY, REDWALL_QUEUED — state forwarded to the renderer
 *
 * Errors are written to stderr and exit non-zero. The Bun path in
 * `redwall.ts` falls through on any non-zero exit so a broken bin does
 * not take the Redwall down with it.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { renderRedwall, yearProgress } from "./redwall-render.ts";
import { REDWALL_SUBSET_BYTES } from "./redwall-font.ts";
import { THEMES } from "./themes.ts";

function envInt(name: string): number | null {
  const v = process.env[name];
  if (v === undefined || v === "") return null;
  const n = parseInt(v, 10);
  return Number.isSafeInteger(n) ? n : null;
}

function envStr(name: string, fallback: string): string {
  const v = process.env[name];
  return v !== undefined && v !== "" ? v : fallback;
}

const KNOWN_THEMES: ReadonlySet<string> = new Set([
  "cobalt",
  "dark",
  "flare",
  "light",
  "marble",
  "obsidian",
]);

async function main(): Promise<number> {
  const outPath = envStr("REDWALL_OUT", "");

  const themeSlug = envStr("REDWALL_THEME", "obsidian");
  if (!KNOWN_THEMES.has(themeSlug)) {
    process.stderr.write(`unknown theme: ${themeSlug}\n`);
    return 2;
  }
  const theme = THEMES[themeSlug as keyof typeof THEMES];

  const artPath = `./assets/wallpapers/${themeSlug}.png`;
  if (!existsSync(artPath)) {
    process.stderr.write(`wallpaper not found: ${artPath}\n`);
    return 2;
  }
  const art = new Uint8Array(readFileSync(artPath));

  const state = {
    workers: envInt("REDWALL_WORKERS"),
    version: process.env["REDWALL_VERSION"] ?? null,
    address: process.env["REDWALL_ADDRESS"] ?? null,
    capacity: envInt("REDWALL_CAPACITY"),
    queued: envInt("REDWALL_QUEUED"),
  };

  const png = renderRedwall({
    art,
    font: REDWALL_SUBSET_BYTES,
    theme,
    state: state as never,
    year: yearProgress(new Date()),
  });

  if (outPath !== "") {
    writeFileSync(outPath, png);
    process.stderr.write(`wrote ${outPath}\n`);
  } else {
    process.stdout.write(png);
  }
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`${(err as Error).message}\n`);
    process.exit(1);
  });