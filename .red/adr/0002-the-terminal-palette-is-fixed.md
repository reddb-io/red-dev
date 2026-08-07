# 0002 — The terminal palette is fixed, and the themes leave the terminal window

- Status: superseded by [0003](0003-red-dev-does-not-colour-the-terminal.md)
- Date: 2026-08-06
- Supersedes: the per-theme `TerminalPalette` in `src/themes.ts`, and the prose at `src/main.ts:301-304` ("colouring only the terminal is what makes a theme switch feel half-applied")

## Context

red-dev's ten themes were transcribed from omakub, and each carried a
twenty-value ANSI palette that reached the terminal emulator, the multiplexer,
the system monitor, the editor, the pager and the git UI. That palette was also
the *only* colour data a theme had: the Windows accent and the wallpaper both
derived from it.

The reported symptom was that switching theme looked like it had done nothing.
The cause is structural rather than a bug: every program inside a terminal
window carries its own palette and paints over the sixteen ANSI slots
underneath. When a theme's visible effect is spread across a dozen programs that
each partially override it, the result is neither the old theme nor the new one,
and no single surface reads as "the theme changed".

Meanwhile the identity itself was borrowed. Tokyo Night and Gruvbox are not the
brand, and `reddb-io/brand` now publishes canonical tokens, marks and 26
wallpapers.

## Decision

**One ANSI palette, fixed, for everything inside the terminal window.** It is
defined in `src/terminal-palette.ts`, derived from the vendored brand tokens,
and written on every converge with content that never varies. Alacritty, Windows
Terminal, zellij, btop, lazygit, bat, delta, herdr and opencode all take it.
Neovim stops being themed at all.

**The themes move to the surfaces where a change is unambiguous**: the
wallpaper, the Windows accent and title bars, the GNOME colour scheme and
accent, and VS Code. A theme switch now changes things that are visible at a
glance and that nothing else overrides.

### Why an ANSI table may carry seven hues when the brand publishes one

The brand is emphatic — *"the red is the only accent"* — and on syntax
colouring, *"three tiers, not a rainbow ... a dozen-colour highlighter is the
seven-colour spectrum problem arriving through a plugin"*.

That is a **producer-side** rule: an author choosing how many token classes to
spend colour on, where restraint costs nothing because the author owns both
ends. The ANSI table is **consumer-side**. `ls` emits SGR 34 for a directory,
`git diff` emits 32 and 31, `grep` emits `01;31`, `fzf` emits 36. red-dev does
not choose how many colours those programs use; it chooses only what the slots
look like. Collapsing blue into the neutral ramp does not produce restraint — it
produces a terminal where a directory is indistinguishable from a file.

So the ANSI table is treated as a compatibility interface, not a brand surface.
The brand's intent is honoured and measured rather than asserted: **exactly one
slot carries the accent's chroma.** `#ff2056` is the only value at saturation
1.000; every other chromatic slot is capped at 0.692, the chroma of the one
non-accent colour the brand has decided. Ten of the twenty values are published
tokens, unmodified. `src/terminal-palette.test.ts` enforces both.

### Where the eight unpublished values come from

Nothing is a taste judgement. Every magnitude derives from a brand-decided
input, and the test recomputes the derivation from the vendored tokens rather
than trusting the literals.

```
dL      = L(red.400) - L(red.500) = 0.131   the ramp's own bright step
h(blue) = h(neutral.400)          = 223.6   the ramp is ALREADY blue
h(cyan) = mid(h(green), h(blue))  = 182.8
h(mag)  = mid(h(blue), h(red))    = 284.6
chroma  = S and L of --ok         = 0.692 / 0.580
bright  = same hue and S, L + dL, except where a token exists
```

Blue is the load-bearing one and it is not invented: the entire neutral ramp
measures 220–227°, so it is a cool-tinted *blue*. `neutral.400` is a blue at
S=0.105. Raising its chroma to the level the brand already chose for `--ok`
yields the brand's own blue. Cyan and magenta follow as hue midpoints.

`green` and `yellow` are `--ok #4ade80` and `--warn #fbbf24`, locked in brand
issue #10 and deliberately unpublished. Adopting an undecided brand value is the
shape brand ADR 0006 sanctions; inventing a different green would be the fork it
forbids. Every non-token value carries a `LOCAL OVERRIDE` comment naming the
upstream issue, so the fork is a labelled seam rather than silent invention.

## Consequences

**Accepted, with the reasons recorded.**

- **`brightBlack` measures 3.87:1 on ink, below AA.** It is inherited, not
  invented: it is the brand's own `--muted`, and `tokens.json` already declares
  `neutral.500` as failing normal text on every dark ground. It is the dim slot
  — comments, ignored files, elapsed times — and being quiet is its function.
  The alternative, `neutral.400` at 6.36, sits one ramp step from the foreground
  and stops reading as dim at all.
- **`blue` clears AA by 0.7%** (4.53 against a 4.5 floor). Pinned by test so a
  later tweak to the chroma rule cannot drop it silently.
- **VS Code reduces to light and dark.** No RedDB VS Code theme is published, so
  the honest maximum is `Default Dark Modern` / `Default Light Modern`. The
  marketplace `--install-extension` path — and the `code.cmd` bug and the
  `unsupported` special case that came with it — leaves the theme hot path.
  Extensions already installed go inert rather than being uninstalled.
- **Themes no longer change the terminal**, which is the point, and which will
  surprise anyone expecting the old behaviour. The wallpaper and the system
  accent carry the signal instead.

## The conflict left open

Brand issue #10 rules that *"the accent never signals error"*. In a terminal,
ANSI slot 1 **is** how error is signalled — by every compiler, every failed
test, every `git diff` deletion. There is no ANSI-conformant way to avoid it:
the slot is named `red` and the programs choose it, not us.

`#ff2056` goes in slot 1 anyway. The alternative — `--danger #ff5470` for slot 1,
accent reserved for the cursor — puts two reds 4.7° apart at identical
saturation in one sixteen-slot table, which reads as a rendering bug rather than
a distinction.

This is a brand-level question that red-dev should not answer alone, and it is
filed upstream along with the four other gaps this work surfaced:

1. **There is no terminal palette in the brand**, and there are already three
   consumers of one — red-dev, `design-system`'s `generateTerminalPalette()`,
   and the docs code blocks. This is the real gap.
2. **Publish success / warning / danger.** ADR 0011 there already names the
   absence a cost. Note that `#4ade80` and `#fbbf24` are Tailwind `green-400`
   and `amber-400` verbatim, and that `#fbbf24` measures S=0.964 — within 4% of
   the accent's saturation, which is the "second accent" `house.md` forbids.
   That may be exactly why they were never published.
3. **Blue, cyan and magenta have no brand answer at all.** The derivation above
   is offered upstream: the ramp is already 223.6°, so the brand owns a blue it
   has never named.
4. **`red.500` on ink is 5.34:1** — AA, not AAA — and is about to be the error
   colour on every RedDB developer's screen.
