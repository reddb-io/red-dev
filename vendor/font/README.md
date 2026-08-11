# vendor/font

Provenance for `assets/fonts/redwall-firacode-subset.ttf`, the font
Redwall draws with. Pinned in `font.lock.json`; the OFL it ships under is
`LICENSE-OFL.txt`, copied byte-for-byte from the upstream release.

## Why a subset and not the face

FiraCode Nerd Font Mono is 2.7 MB and 12,780 glyphs. Redwall writes a small,
derived alphabet of human status phrases, digits and separators. Embedding
the whole face to reach them would put
more unused outline data into the binary than the six wallpapers weigh
together.

## Why a licence file here and not in vendor/brand

`brand-lock.test.ts` explains the other side of this:

> The claim that keeps LICENSE-assets.md out of this repo: red-dev
> re-encodes nothing, so there is no derived work to license.

A subset is a derived work — a Modified Version under OFL 1.1 clause 2 —
so the licence has to travel with it. `font.lock.json` records
`subset.unaltered: false` for exactly that reason, and
`redwall-font.test.ts` asserts both halves: that the flag still says
`false`, and that the OFL is still there and still reachable from the
lock.

## Why the character set is derived, not listed

`src/redwall-charset.ts` builds the set from `REDWALL_LABELS` plus the
digits and separators an address needs. A slice that adds a label widens
the set, which breaks the test against the committed subset, which says
re-vendor. The alternative — a hand-kept list beside the labels — drifts
the first time somebody adds a word, and the failure is a row of
`.notdef` boxes on somebody's desktop rather than a red build.

## Re-vendoring

```
tag=v3.5.0
mkdir -p /tmp/nerd-fonts && cd /tmp/nerd-fonts
curl -sSLO "https://github.com/ryanoasis/nerd-fonts/releases/download/$tag/FiraCode.tar.xz"
tar -xJf FiraCode.tar.xz
commit=$(curl -sS "https://api.github.com/repos/ryanoasis/nerd-fonts/git/ref/tags/$tag" \
  | grep -o '"sha": "[0-9a-f]\{40\}"' | head -1 | cut -d'"' -f4)

cd -
bun run scripts/vendor-font.ts \
  --release /tmp/nerd-fonts --archive /tmp/nerd-fonts/FiraCode.tar.xz \
  --tag "$tag" --commit "$commit"
```

The commit lookup is separate because a release tag is not a commit: the
API's `target_commitish` on the release object says `master`, which is a
branch and will mean something different next month.

The script refuses to write a subset that does not cover the declared
character set, rewrites every mechanical field in the lock, and preserves
`why` — the one field that is an argument rather than a measurement.

**Never edit the subset or the OFL copy by hand.** The subset is
generated, and a hand-edited font is a font whose lock is a lie.

## What the subset drops

`GSUB`, `GPOS` and `GDEF` (FiraCode's ligature machinery — 65 KB of the
source, and Redwall composes no ligatures), `gasp`, the hinting triple
`cvt `/`fpgm`/`prep` together with every glyph's instructions, and the
`post` glyph-name array. Hinting is instructions for a hinting
interpreter, and the rasteriser Spec #52 calls for has none; keeping the
instructions while dropping the control values they index would leave the
font pointing at tables that are no longer there.

Outlines themselves are copied verbatim. The subset's glyph for `0` is
byte-identical to the face's, which is what makes "generated, not
hand-built" checkable rather than aspirational.
