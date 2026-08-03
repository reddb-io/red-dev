#!/usr/bin/env bun
/**
 * Does every VS Code extension we name actually exist?
 *
 * Three of the ten did not. `AndreiVoronkov.matte-black`,
 * `solomonhyt.osaka-jade` and `kaiwood.monokai-pro` were all plausible
 * — right shape, right-sounding publisher — and all three had never
 * been published. Nothing failed loudly: `code --install-extension`
 * returned non-zero, red-dev warned once in a wall of output, and the
 * editor stayed on its old theme while the run reported success.
 *
 * That is the same failure this project was started over: a provider
 * pointing at a name nobody checked. The manifest's `gh` provider
 * resolves against the real release for exactly this reason, and there
 * was no equivalent for the marketplace until now.
 *
 * Network-bound, so it is a script rather than a unit test — it runs in
 * CI beside the render smoke.
 */

import { VSCODE_THEMES } from "../src/theme-editors.ts";

const API = "https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery";

async function exists(id: string): Promise<boolean> {
  const res = await fetch(API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json;api-version=3.0-preview.1",
    },
    // filterType 7 is an exact name match, so a typo returns nothing
    // rather than the nearest neighbour.
    body: JSON.stringify({
      filters: [{ criteria: [{ filterType: 7, value: id }], pageSize: 1 }],
      flags: 914,
    }),
  });
  if (!res.ok) throw new Error(`marketplace returned ${res.status}`);
  const body = (await res.json()) as {
    results?: { extensions?: { extensionName: string }[] }[];
  };
  return (body.results?.[0]?.extensions?.length ?? 0) > 0;
}

const missing: string[] = [];
for (const [slug, spec] of Object.entries(VSCODE_THEMES)) {
  if (spec.status !== "exact") continue;
  const ok = await exists(spec.extension);
  console.log(`  ${ok ? "ok     " : "MISSING"} ${slug.padEnd(12)} ${spec.extension}`);
  if (!ok) missing.push(`${slug} -> ${spec.extension}`);
}

if (missing.length > 0) {
  console.error("\nVSCODE THEME CHECK FAILED");
  for (const m of missing) console.error(`  ${m}`);
  console.error("\nA theme that names a nonexistent extension leaves the editor unthemed");
  console.error("and reports success. Fix the id, or drop the mapping so it skips honestly.");
  process.exit(1);
}

console.log("\nVSCODE THEMES OK");
process.exit(0);
