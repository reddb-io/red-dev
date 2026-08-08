/**
 * The vendored font has to be true, the same way the brand lock does.
 *
 * `brand-lock.test.ts` records why: a lock nothing checks is a comment
 * that looks like a guarantee. The font carries one extra claim the
 * wallpapers do not, and it is the one that matters most here — the
 * wallpapers are vendored `unaltered`, so there is no derived work and
 * no licence text to ship. A subset is a modification: the OFL travels
 * with it or the vendoring is not legal, so the licence file is checked
 * to be present, reachable from the lock, and byte-for-byte what upstream
 * shipped.
 *
 * The other half is the subset itself. "Only the characters Redwall
 * draws" is the kind of claim that rots the first time somebody
 * re-subsets from a wider set and nobody notices, so it is read out of
 * the font's own cmap rather than believed.
 *
 * What this cannot check, exactly as with the brand, is that the bytes
 * came from ryanoasis/nerd-fonts at the pinned commit. That release is
 * not a dependency here and is not present in CI. `vendor/font/README.md`
 * is the procedure; the upstream half is verified at vendor time.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import lock from "../vendor/font/font.lock.json" with { type: "json" };
import { REDWALL_CHARSET, REDWALL_LABELS } from "./redwall-charset.ts";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import { cmapCoverage, numGlyphs } from "./ttf.ts";

const root = `${import.meta.dir}/..`;

async function digest(rel: string): Promise<string> {
  const bytes = await Bun.file(`${root}/${rel}`).bytes();
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("the character set Redwall draws", () => {
  test("is derived from the labels rather than transcribed beside them", () => {
    // The labels are the source of truth. A slice that adds a third one
    // widens the charset here, and every assertion below then demands a
    // re-subset — which is the point: the font cannot silently stop
    // covering what the overlay draws.
    for (const label of REDWALL_LABELS) {
      for (const ch of label) expect(REDWALL_CHARSET, label).toContain(ch);
    }
  });

  test("is sorted, deduplicated, and carries the digits and separators an address needs", () => {
    const points = [...REDWALL_CHARSET].map((ch) => ch.codePointAt(0)!);
    expect(points).toEqual([...points].sort((a, b) => a - b));
    expect(new Set(points).size).toBe(points.length);
    for (const ch of "0123456789.: ") expect(REDWALL_CHARSET).toContain(ch);
  });
});

describe("the vendored subset", () => {
  test("is declared in the lock and matches the digest claimed for it", async () => {
    expect(existsSync(`${root}/${lock.subset.path}`), lock.subset.path).toBe(true);
    expect(await digest(lock.subset.path)).toBe(lock.subset.sha256);
  });

  test("is the file the binary embeds", async () => {
    // `with { type: "file" }` yields a path that differs between
    // `bun run` and a compiled binary, so the two sides are compared by
    // content. A lock entry pointing at a file nothing imports would
    // otherwise pass every other test in this block.
    const embedded = await Bun.file(REDWALL_SUBSET).bytes();
    expect(embedded.length).toBeGreaterThan(0);
    expect(new Bun.CryptoHasher("sha256").update(embedded).digest("hex")).toBe(lock.subset.sha256);
  });

  test("names the upstream release, commit and face it was cut from", () => {
    expect(lock.source).toBe("ryanoasis/nerd-fonts");
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(lock.nearestTag).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(lock.upstream.face).toMatch(/^FiraCode.*\.ttf$/);
    expect(lock.upstream.faceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lock.why.length).toBeGreaterThan(0);
  });

  test("declares itself derived, which is what makes the licence load-bearing", () => {
    // The mirror image of the brand lock's `unaltered: true`. That claim
    // is what keeps a licence file out of vendor/brand; this one is what
    // puts one into vendor/font.
    expect(lock.subset.unaltered).toBe(false);
    expect(lock.subset.generatedBy).toBe("scripts/vendor-font.ts");
  });
});

describe("the OFL", () => {
  test("ships beside the subset and is reachable from the lock record", async () => {
    expect(existsSync(`${root}/${lock.license.file}`), lock.license.file).toBe(true);
    expect(await digest(lock.license.file)).toBe(lock.license.sha256);
    expect(lock.license.id).toBe("OFL-1.1");
  });

  test("is the licence text and not a stub pointing at one", async () => {
    const text = await Bun.file(`${root}/${lock.license.file}`).text();
    expect(text).toContain("SIL OPEN FONT LICENSE Version 1.1");
    expect(text).toContain("PERMISSION & CONDITIONS");
    expect(text).toContain("The Fira Code Project Authors");
  });
});

describe("what the subset actually contains", () => {
  test("covers every character Redwall draws, and nothing else", async () => {
    const bytes = await Bun.file(`${root}/${lock.subset.path}`).bytes();
    const covered = [...cmapCoverage(bytes).keys()]
      .sort((a, b) => a - b)
      .map((cp) => String.fromCodePoint(cp))
      .join("");

    expect(covered).toBe(REDWALL_CHARSET);
    expect(lock.subset.characters).toBe(REDWALL_CHARSET);
  });

  test("carries one glyph per character plus .notdef, not a patched face", async () => {
    // FiraCode Nerd Font Mono is ~12,780 glyphs and 2.7 MB. If a
    // re-vendor ever copies the whole face into assets/, the cmap check
    // above still passes when the subsetter is skipped and the cmap is
    // rebuilt — this is the one that does not.
    const glyphs = numGlyphs(await Bun.file(`${root}/${lock.subset.path}`).bytes());
    expect(glyphs).toBeLessThanOrEqual(REDWALL_CHARSET.length + 1);
    expect(lock.subset.glyphCount).toBe(glyphs);
  });
});
