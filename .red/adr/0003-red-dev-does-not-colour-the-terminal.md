# 0003 — red-dev does not colour the terminal

- Status: accepted
- Date: 2026-08-07
- Supersedes: [0002](0002-the-terminal-palette-is-fixed.md), and with it `src/terminal-palette.ts` in its entirety

## Context

ADR 0002 removed *per-theme* terminal colouring and replaced it with one fixed
RedDB palette: twenty values written into Alacritty, Windows Terminal, zellij,
btop and lazygit on every converge, identical whichever theme was active.

That solved the problem it was aimed at. Switching theme stopped looking like it
had failed, because the thing that varied — wallpaper, system accent, GNOME,
VS Code — was no longer competing with a dozen programs each repainting the
sixteen ANSI slots underneath.

It did not solve the problem underneath it, which only became visible once the
first one was out of the way: **a terminal's colours are not red-dev's to
choose.** A provisioning tool that installs fonts, binds hotkeys, sets up a
multiplexer and standardises a shell is doing work the user delegated. Deciding
what blue looks like is not that. The fixed palette was a smaller version of the
same overreach — one opinion instead of ten, still imposed, and now
*permanently* imposed since it no longer varied and no command changed it.

The palette was also expensive to be right about. The brand publishes one
chromatic value, so five hues had to be derived and two adopted from an
unpublished issue. ADR 0002 argued the derivation carefully and the argument
still holds, but it was six hundred words of justification for a decision with
no user behind it.

## Decision

**red-dev writes exactly one colour into a terminal: the cursor.**

`src/terminal-cursor.ts` is what remains of `src/terminal-palette.ts`. It
exports `CURSOR` — `red.500`, read from the vendored tokens — and a
`cursorToml()` that emits `[colors.cursor]` and nothing else.

The cursor survives the deletion because it is categorically different from the
sixteen. Nothing is *rendered in* it: it is a caret, not a slot a program can
emit an SGR code for. So it cannot clash with a scheme the user picks, it cannot
make a directory indistinguishable from a file, and it is the one visible mark
that says this terminal was set up by this tool. Its companion value is
`text = 'CellBackground'` rather than a hex, because the character under the
cursor has to stay legible on a background red-dev no longer sets and therefore
no longer knows.

### Three groups, and the one where deleting adds colour

Removing "everything red-dev writes" is not a single action. The settings split
three ways, and the middle group behaves opposite to how it reads.

**Define the sixteen.** Alacritty's `theme.toml` and the Windows Terminal
`RedDB` scheme. These are the only two that actually paint a terminal. Both are
deleted, and the deletion is swept on every converge rather than recorded in the
ledger — the policy `src/wsl.ts` already used for retired schemes, which reaches
a machine that skipped a release and has nothing to remember having done.
`theme.toml` is removed rather than renamed to `cursor.toml`: a machine that
converged before this release would otherwise keep importing twenty values
forever. `RETIRED_PARTS` in `src/alacritty.ts` exists so the import line goes
with the file.

**Decline to pick.** `bat` and `delta` on `base16`, `opencode` on `"system"`,
`herdr` on `name = "terminal"`, `btop` on `TTY`. Every one of these means
*render through the host terminal's own colours*. **They are kept**, and that is
not a contradiction of this ADR: they pick no colour, they are the instruction
that stops a program picking one.

Deleting them would produce the outcome this ADR is trying to prevent. `bat`
with no config falls back to Monokai Extended, whose twenty-four-bit values
ignore the terminal entirely — so removing the line is how you get a purple
pager inside a terminal the user just chose the colours for. The test for
whether a setting belongs here is not "did red-dev write it" but "does it make
the colours come from the user's terminal".

`btop` is the one that needed a positive choice rather than a deletion. Its
`color_theme` line pointed at a file this release removes, and simply dropping
the line leaves it on `Default`, painting its own greens and blues. `TTY` is a
builtin that renders through the sixteen — the same answer as the other four, in
btop's vocabulary. Deliberately *not* `tty_mode`, which is a different setting
that also swaps the graph symbols for ASCII.

**Already painted.** zellij, btop and lazygit had hexes written into them.
`clearZellij`, `clearBtop` and `clearLazygit` remove red-dev's own blocks and
nothing else. zellij's theme line has to go with its theme file, because zellij
refuses to start on a theme name it cannot resolve — a colour cleanup that left
one behind would be a broken multiplexer. lazygit needs nothing written back:
its default theme is written in ANSI colour *names*, so removing the block is
the whole job.

## Consequences

**A theme is now unambiguously a desktop thing.** Wallpaper, Windows accent and
prevalence, GNOME, VS Code. Nothing a theme touches is inside a terminal window,
so the confusion ADR 0002 diagnosed cannot recur in a weaker form.

**The five derived hues are gone, and so is the argument for them.** Blue, cyan,
magenta and the two bright variants were the most-reasoned and least-owned part
of the codebase. `reddb-io/brand#105` — "there is no terminal palette, and three
products have each invented one" — stays open and matters *more* now: red-dev
has stopped being one of the three, which removes a data point but not the gap.

**`brightBlack` at 3.87:1 stops being red-dev's problem.** ADR 0002 shipped one
value below WCAG AA, inherited from the brand's own `--muted`. There is no
sixteen-slot table here to hold it in.

**Users on a machine that took 0.21.0 lose a palette they may have liked.** It
was in one release, for one day. The sweep is silent about what the colours were
and offers no way back beyond the user setting them in `alacritty.toml` — which
red-dev creates once and never rewrites, and which Alacritty loads *after* the
imports so anything put there wins.

**One risk accepted:** the sweeps edit files the user co-owns. Every one matches
on the `Generated by red-dev` prefix rather than the full marker sentence, whose
wording has now changed three times; matching the current spelling would strand
every machine configured before it and leave exactly the colours this ADR
removes. `src/terminal-release.test.ts` asserts the other half — that a
config red-dev never wrote is not edited, and that the user's keybindings,
update rate and paging settings survive the block being cut out from between
them.
