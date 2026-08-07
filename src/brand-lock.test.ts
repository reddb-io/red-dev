/**
 * The lock has to be true, or it is worse than not having one.
 *
 * vendor/brand/brand.lock.json records a sha256 for every vendored file
 * and claims each was taken `unaltered` from a named commit. Until this
 * file existed, nothing checked any of it — the lock was a comment that
 * looked like a guarantee. A re-vendor that updated the PNGs and forgot
 * the digests, or updated the digests and forgot the PNGs, produced a
 * repo that documented a provenance it did not have.
 *
 * What this cannot check is the other half of the claim: that the bytes
 * match the *brand* at that commit. The brand is not a dependency here
 * and is not present in CI. So the test verifies internal consistency —
 * the lock describes the files that are actually committed — and the
 * upstream half stays a manual step, done at vendor time with the brand
 * checked out beside this repo.
 *
 * vendor/brand/README.md is the procedure. The short version: never edit
 * either side by hand.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import lock from "../vendor/brand/brand.lock.json" with { type: "json" };
import { themeNames } from "./themes.ts";

const root = `${import.meta.dir}/..`;

async function digest(rel: string): Promise<string> {
  const bytes = await Bun.file(`${root}/${rel}`).bytes();
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

describe("the vendored token source", () => {
  test("matches the digest the lock claims for it", async () => {
    for (const [rel, sha] of Object.entries(lock.files)) {
      expect(await digest(`vendor/brand/${rel}`), rel).toBe(sha);
    }
  });
});

describe("the vendored wallpapers", () => {
  const entries = Object.entries(lock.wallpaper);

  test("are the files the lock says they are", async () => {
    for (const [rel, spec] of entries) {
      expect(existsSync(`${root}/${rel}`), rel).toBe(true);
      expect(await digest(rel), rel).toBe(spec.sha256);
    }
  });

  test("cover every theme, and nothing else", () => {
    // The other direction from wallpaper.test.ts, which reads the
    // directory. This reads the lock, so a PNG committed without a lock
    // entry fails here even though the directory listing looks right.
    const locked = entries.map(([rel]) => rel.split("/").pop()!.replace(/\.png$/, "")).sort();
    expect(locked).toEqual([...themeNames()].sort());
  });

  test("each name an upstream path in the brand's own layout", () => {
    // A `from` that stopped matching the brand's naming is the first
    // sign a re-vendor was done by copying rather than by the procedure.
    for (const [rel, spec] of entries) {
      expect(spec.from, rel).toMatch(/^assets\/wallpaper\/reddb-wallpaper-\d{2}-[a-z-]+-3840x2160\.png$/);
    }
  });

  test("are still declared unaltered", () => {
    // The claim that keeps LICENSE-assets.md out of this repo: red-dev
    // re-encodes nothing, so there is no derived work to license. If a
    // future change needs to touch the bytes, this assertion is the one
    // that should stop it and force the licence question to be answered.
    for (const [rel, spec] of entries) {
      expect(spec.unaltered, rel).toBe(true);
    }
  });
});
