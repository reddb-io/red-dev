# Omarchy Quattro After Release — Delta and red-dev Decisions

**Date:** 2026-08-15

**Query:** Now that Omarchy Quattro (v4.0.0) has shipped, what actually changed
against the 2026-08-03 study, and what does red-dev adopt — across hotkeys,
programs, integrations and philosophy — versus leave alone?

**Scope:** The Quattro launch tour (transcript, ~11k words, read inline), the
`basecamp/omarchy` repository at `7be59e1f` (default branch `quattro`, 17
commits past the `v4.0.0` tag published 2026-08-14T16:35Z, read from a shallow
clone), and red-dev at 1.0.13 on branch `agent/npm-mise-reshim`. The three
2026-08-03 studies and the 2026-08-11 agent-surfaces note remain the baseline;
this note records only the delta and the decisions taken in the grilling
session of 2026-08-15. It is **not cached in `.red/wiki/`** — `/wiki-init` has
not been run in this repository.

## Executive Summary

Quattro is the architectural rewrite the 2026-08-03 study warned not to treat
as released. It is released now, and the shape it settled on is: Omarchy as a
**system package** (`omarchy` + `omarchy-settings`) with the person's changes
layered in `~/.config/omarchy` and `~/.config/hypr/*.lua`; **Quickshell** as the
one shell (bar, menu, launcher, notifications, clipboard, emoji, panels —
Waybar, Walker, Mako, SwayOSD, hyprlock, hypridle all removed); a **plugin
system** with `manifest.json`, clone-to-override and `shell.json` persistence;
a **default agent** with crash capture and an **agents usage panel**; and
**mise as the agent installer**, so `mup` updates every agent out of band.
Foot is the default terminal. Bindings moved to Lua. The menu is JSONC data.

None of it changes red-dev's course. ADR 0001 (cross-platform, contracts +
adapters + profiles, not a distro) was **reaffirmed**, and the session decided
thirty things — the important ones being: **one chord family (`Ctrl+Alt`) on
every target, never Super/Win** (ADR 0006); **a user layer for every owned file**
(ADR 0007); a **default agent that never launches in bypass mode**; **agent usage
on the Redwall and in `doctor`**, read from bounded collectors that never
launch an agent process; **Panels** as TUIs over first-party CLIs; a **keys
viewer that executes**; **web apps wired** from the orphaned module; an **emoji
picker** as a TUI; **`red-dev agents update`** inside `red-dev update`;
**catalogue symmetry** (untick removes); and a **product skill** the default
agent is briefed with. What was explicitly not adopted is listed at the end.

## Official Sources

- [Omarchy repository](https://github.com/basecamp/omarchy) — read at
  `7be59e1f` (2026-08-15); default branch `quattro`; MIT.
- [Omarchy v4.0.0 release](https://github.com/basecamp/omarchy/releases/tag/v4.0.0)
  — "The Quattro Release", 2026-08-14.
- [Omarchy manual](https://learn.omacom.io/2/the-omarchy-manual) — 51
  chapters shipped in `manual/`.
- [omarchy.org](https://omarchy.org) — "Omarchy Quattro has been released!"
- [herdr.dev](https://herdr.dev) — Herdr, Inc.; Apache 2.0; the "Herder" of
  the video.
- The launch tour video — transcript read inline; auto-captioned, see
  the naming corrections below.
- Local: `.red/researches/2026-08-03-omarchy-deep-dive-and-red-dev-opportunities.md`,
  `.red/researches/2026-08-11-unified-agent-input-and-usage-surfaces.md`,
  ADRs 0001–0007, `.red/contexts/**`.

## Naming Corrections (transcript → repository)

The captions garble most product names. Read them as:

| Transcript | Actual | Where |
|---|---|---|
| Umachi / Amachi / Omachi / Amethyst / Ulauncher | **Omarchy** | — |
| Quick Shell | **Quickshell** | `shell/` (95 QML files) |
| Hyperland | **Hyprland** | `default/hypr/` |
| Herder | **herdr** | `config/herdr`, `Super+Ctrl+Return` |
| Mees / Meece | **mise** | `install/user/mise.sh`, alias `mup` |
| Ether | **Aether** (theme extractor GUI) | `omarchy-other.packages` |
| Vox Type | **Voxtype** (dictation) | `bindings/voxtype.lua` |
| Clipped | **Cliamp** (music TUI) | `Super+Shift+Alt+M` |
| Amorite | **Omawrite** | `Super+Shift+W` |
| Tupperole / Topperole | **Typora** (replaced by Omawrite) | release notes |
| Limnoria | **Limine** (bootloader; snapshots) | `default/limine` |
| Amacon | **omacom** (GitHub org) | — |
| OMP | **omp** (oh-my-pi) | `install/user/mise.sh` |
| Twey | **TUI** (Install › TUI) | `omarchy-tui-install` |
| Amakub | **Omakub** (the original wallpaper) | `themes/` |
| Omasign | **not in the repository** (announced, unshipped) | — |
| "Ohmyzsh.com plugin site" | **omarchyplugins.com** | `manual/32-shell-plugins.md` |

## Key Findings

### What Quattro changed since the 2026-08-03 study

| Area | Stable 3.8.x (studied 08-03) | Quattro (`7be59e1f`) |
|---|---|---|
| Shell | Waybar + Walker + Mako + SwayOSD + hyprlock/hypridle | **Quickshell** for everything (`shell.qml` 1,031 lines; plugins in `shell/plugins/`) |
| Delivery | git checkout in `~/.local/share/omarchy` | **system packages** `omarchy`, `omarchy-settings`, `omarchy-keyring`, `omarchy-nvim`; `/usr/share/omarchy` immutable; `/etc/skel` seed → user layer |
| Config language | Hyprland `.conf` | **Lua** (`hyprland.lua`, `bindings.lua`; `hl.unbind` for user overrides; two switches to disable default/preinstalled bindings) |
| Menu | shell script tree | **JSONC** (`default/omarchy/omarchy-menu.jsonc`, user overlay `~/.config/omarchy/extensions/`) |
| Terminal | Alacritty → Ghostty | **foot** default; Alacritty/Ghostty/Kitty installable and themed |
| Plugins | none | `manifest.json` kinds (bar-widget, panel, overlay, menu, service, bar); `omarchy plugin add|clone|enable|disable|remove|update|validate`; `~/.config/omarchy/shell.json` |
| Agents | aliases | **default agent** (`omarchy default agent`, `Super+Shift+Ctrl+A`, launched with `--permission-mode auto`/`--yolo`/`--approve-for-me`), `omarchy-crash-watch.service` → `omarchy-agent-crash`, skills `default/agents/skills/{omarchy,diagnose-crash}` symlinked into `~/.claude/skills`, `~/.codex/skills`, `~/.pi/agent/skills`; usage panel (Claude / Codex / Fireworks, 15-min collectors; the Codex collector **starts the app-server**) |
| Agent install | pacman/AUR | **mise stubs** in `~/.local/bin` (`omarchy-mise-install`, `MISE_MINIMUM_RELEASE_AGE=0`); `mup` = `mise up`; `omarchy update` runs it |
| Channels | stable/dev | stable / rc / edge / dev; `stable-mirror.omarchy.org` one month behind; ALPM hook blocks direct `pacman -Syu` |
| Recovery | snapshots | snapper + limine, snapshot before update, **factory reset** from `@factory` (ISO installs only) |
| Themes | 19 | **22** (`last-horizon`, `lupine`, `solitude`); `colors.toml` → 17 templates; Aether extracts a theme from an image |
| Bin surface | ~350 scripts | **424** `omarchy-*` scripts + the `omarchy` router (~30.7k lines) |
| Removed | — | Waybar, Walker, Mako, SwayOSD, hyprlock, hypridle, swaybg, polkit-gnome, iwd/impala/bluetui/wiremix, Typora, Satty, GNOME Calculator |
| Own apps | — | Omawrite, Omacalc, Omacut, ttfx (Rust screensaver), Aether, Cliamp, tensaku (annotator) |

Interaction details worth keeping in mind: `Super+K` viewer filters and **Enter
executes**; `Super+C/V/X` are terminal-aware (send `Ctrl+Insert`/`Shift+Insert`
to windows tagged `terminal`); CapsLock is compose (`m s` → 😄, `space n` →
name, `space e` → e-mail); `Super+Ctrl+1..9` toggles the nth bar panel;
Panels on `Super+Ctrl+A/B/D/Alt+D/W/P`; DNS under Setup › Network › DNS
{DHCP, Cloudflare, Google, Custom} plus a network QR code; SSH server
authorizes `github.com/<user>.keys` and `ufw limit 22`; `Remove › Preinstalls`
sweeps every web app, TUI wrapper, mise stub and bundled GUI app in one go.

### Where red-dev stands on the same four axes

| Axis | red-dev 1.0.13 |
|---|---|
| Hotkeys | Global chords only on a Windows host: `Ctrl+Alt+T`, `Ctrl+Alt+Shift+T` (`src/hotkeys.ts`). Zero GNOME bindings. Terminal layer identical on all five targets: zellij `locked` with `Ctrl-g`, Shift+Enter → CSI-u and Alt+V → raw `Ctrl+V` in Alacritty, Windows Terminal, readline, Claude, RedCode (`src/shift-enter.test.ts`). No keys viewer; the semantic-action schema was promised, nothing generated. |
| Programs | Manifest scopes `core` 41 · `desktop` 9 · `wsl` 5 · `optional` 11; agents 11 (three recommended); runtimes via mise (`node@24` default). Web apps: `src/webapps.ts` complete and **imported nowhere**; the shipped path is the `web2app` bash function, hard-coded to `google-chrome`. |
| Integrations | `red-dev update` = apt/winget + red-skills + converge; installed agents are skipped, so on Linux/WSL codex, gemini, hermes (npm under mise's node) and redcode (GitHub release) are **never updated by red-dev**. Redwall already carries GitHub `api/gql` budgets and Worker state; Codex statusline shows its own limits. `ssh-server` opens the port and installs the service, authorizes no key. No default agent. Crash logs, `logs`, transcripts, migrations exist. |
| Philosophy | ADR 0001 (not a distro; contracts + adapters + profiles), ADR 0003 (red-dev does not colour the terminal), ADR 0004/0005 (Reclaim asked for; Rescue evidence-driven), "chosen, not assumed" agents, install never prompts, `Ctrl+Shift+T` deliberately unclaimed. |

### Convergences

- **herdr.** Omarchy adopted it (`Super+Ctrl+Return`, Learn › Herdr keybindings,
  `config/herdr`); red-dev already installs it and builds the RedSkills herdr
  extension. Same tool, same reason (agents alive over SSH).
- **Shift+Enter.** Both emit `ESC[13;2u`; Quattro also enables tmux extended
  keys. Already covered by the 08-11 note.
- **mise** owns runtimes on both sides.
- **"Chosen, not assumed."** Omarchy: "it doesn't pick a favorite for you"
  (no default agent out of the box). red-dev: agents are a pre-ticked choice.

## Decisions (2026-08-15 grilling session)

Every question below was put to the maintainer with a recommendation; the
maintainer accepted the recommendation in each case. "Recorded in" is where the
decision now lives — this note is a log, not the source of truth.

| # | Decision | Recorded in |
|---|---|---|
| Q01 | Cache sources in `/wiki` — **blocked**: `/wiki-init` is user-invocable only and asks which of `CLAUDE.md`/`AGENTS.md` to create (neither exists). Material stays uncached until it is run. | this note |
| Q02 | Decisions inline + this dated research note. | — |
| Q03 | ADR 0001 **reaffirmed** post-Quattro; the "do not copy" list gains "default agent in bypass mode". | ADR 0001 amendment |
| Q04 | Agent usage: **compact on the Redwall, detail in `doctor` / `red-dev agents status`**. | `agents/CONTEXT.md` (Agent usage), `visual/CONTEXT.md` (Redwall) |
| Q05 | Adopt a **Default agent**: one chosen host, target of crash diagnosis and of a launch chord; **never** started with a permission bypass. | `agents/CONTEXT.md` (Default agent) |
| Q06 | Answer to `mup`: **`red-dev agents update`**, each host by its publisher's path (npm `-g`, GitHub release, winget, self-update). Not the mise `npm:` backend — this branch just contained mise's unbounded reshim. | `agents/CONTEXT.md` |
| Q07 | ADR 0004's "red-dev schedules nothing" is stale since the Redwall timer; **amend**, scoping the prohibition to Reclaim/Rescue. | ADR 0004 amendment |
| Q08 | **Panels** (network/DNS, audio in/out, power, bluetooth) as red-dev TUIs over first-party CLIs; fall back to the host's native panel where none exists (audio devices, bluetooth on Windows). | `interaction/CONTEXT.md` (Panel) |
| Q09 | **One chord family on every target — `Ctrl+Alt` — never Super/Win.** | ADR 0006, `interaction/CONTEXT.md` (Chord) |
| Q10 | The semantic-action **schema is born now**, seeded with today's bindings; **`red-dev keys`** is its first consumer. | `interaction/CONTEXT.md` (Semantic action) |
| Q11 | Universal clipboard (`Super+C/V/X`) — **out of scope**. | `interaction/CONTEXT.md` (Relationships) |
| Q12 | New `optional` groups: **services** (Tailscale, 1Password, Bitwarden, LocalSend) and **dev CLIs** (`try`, `dua`, `yt-dlp`). Not Omarchy's own GUI apps. | this note; manifest work |
| Q13 | **Wire `src/webapps.ts`** into `red-dev apps` (install/remove; Linux `.desktop`, Windows `--app` shortcut); retire the `web2app` bash function. | `interaction/CONTEXT.md` (Web app) |
| Q14 | **User layer** for every owned file, loaded after red-dev's, never written by a converge; composed where the program cannot include (zellij). | ADR 0007, `visual/CONTEXT.md` (User layer) |
| Q15 | Usage collectors cover **only what can be read without launching a process** — Claude via local credentials/HTTP first; Codex when its CLI exposes limits; never an app-server. | `agents/CONTEXT.md` (Relationships) |
| Q16 | SSH server **authorizes keys from a GitHub username**, asked in the interview / `red-dev shell`, never in a plain converge; removal reverts. | this note; `src/ssh-server.ts` work |
| Q17 | Phase-3 capture actions: **screenshot only** (OCR / recording are a later phase if asked). | this note |
| Q18 | ADRs for chord family and user layer — **both written**. | ADR 0006, ADR 0007 |
| Q19 | **Emoji picker as a TUI** (search → clipboard through the three-route clipboard); compose sequences out of scope. | `interaction/CONTEXT.md` (Emoji picker) |
| Q20 | First schema set: what exists + menu, keys viewer, Panels, emoji (+ Q30's agent actions); per-web-app chords are catalogue, not default. | `interaction/CONTEXT.md` |
| Q21 | `red-dev keys` **executes on Enter**. | `interaction/CONTEXT.md` |
| Q22 | Web apps default: **ChatGPT, Claude, GitHub pre-ticked**; Photos/Contacts/Tailscale in the catalogue. | `interaction/CONTEXT.md` (Web app) |
| Q23 | `red-dev update` **includes** the agents update (system → red-skills → agents → converge). | `agents/CONTEXT.md` |
| Q24 | Default agent chosen in the **interview after the hosts** + `red-dev agents default <key>`; **automatic when exactly one CLI host** is selected. | `agents/CONTEXT.md` |
| Q25 | The default agent is briefed with a **product skill** shipped by red-dev (managed paths, `doctor --json`, logs, privilege), installed into agent skills homes; complements RedSkills. | `agents/CONTEXT.md` (Product skill) |
| Q26 | Aether-style **theme from image — no**; six brand themes, imported wallpaper is art only. | this note (ADR 0002/0003 lineage) |
| Q27 | A Panel that needs rights **asks inline** (sudo/UAC) — never queued into `red-dev privileged`. | `interaction/CONTEXT.md` (Panel) |
| Q28 | Menu grows by **flat sections** — Keys, Panels, Agents (default · usage · update), Learn — not Omarchy's tree. | `interaction/CONTEXT.md` |
| Q29 | **Catalogue symmetry**: unticking an installed optional/web app in `red-dev apps` removes it, after naming it. | `provisioning/CONTEXT.md` (Catalogue) |
| Q30 | Agent chords: **`agent.launch`** (default agent) and **`agent.multiplex`** (herdr, reported absent where not installed). | `interaction/CONTEXT.md` |

## Not Adopted, and Why

| Quattro feature | Verdict | Reason |
|---|---|---|
| Hyprland + Quickshell shell, bar plugins | no | Not a distro (ADR 0001); red-dev has no shell to plug into — Panels are TUIs, the Redwall is the status surface |
| Super-centric key map | no | Collides with GNOME and Windows reserved chords; identical `Ctrl+Alt` family instead (ADR 0006) |
| Universal clipboard `Super+C/V/X` | no | Hyprland-specific; the terminal layer already unifies copy/paste; Windows is universal by itself |
| CapsLock compose (emoji, name, e-mail) | no | Linux-only; breaks the identical layer |
| Omawrite / Omacalc / Omacut / Aether / Cliamp / ttfx | no | Linux GUI, personal taste (ADR 0001) |
| Aether theme-from-image | no | ADR 0002/0003 removed invented colour from the product; six brand themes stay |
| Agents as mise `npm:` stubs + `mup` | no | This branch just bounded mise's implicit reshim; publisher paths + `red-dev agents update` instead |
| Codex usage via app-server | no | 08-11 note: no repaint may launch a process; collectors read cached observations only |
| Default agent in bypass/auto-approve | no | Added to ADR 0001's "do not copy" list |
| Omarchy's menu tree (Learn/Trigger/Style/…) | no | Sized for 424 scripts; red-dev grows flat sections |
| Docker DB installers | no | Already decided in `profiles/CONTEXT.md` |
| Update channels rc/edge, one-month-behind mirror, snapshots, factory reset | not now | Lifecycle context, own track; nothing decided here |
| Web app per-app default chords | no | Catalogue, not default (Q20/Q22) |

## Gotchas

- The transcript's names are unreliable — use the corrections table.
- README drift found while reading: it says web apps ship (only the bash
  function does), and that ble.sh is "installed but not enabled" while
  `config/bash/rc.sh:72` makes it on by default since commit `6513dbc`.
- ADR 0004's premise was stale for three days before the amendment; the
  Redwall timer is the only scheduled thing red-dev installs.
- Nothing in this session was cached in the wiki; re-ingest after `/wiki-init`.

## Open Questions

1. Codex usage without an app-server — waits on the Codex CLI exposing limits.
2. Which `Ctrl+Alt+*` chords are actually free on both GNOME and Windows for
   menu, keys, panels, emoji, agent — the schema's conflict check answers this
   before any chord ships.
3. Windows audio-device switching has no first-party CLI; the Panel falls back
   to `ms-settings:` there — revisit if a first-party command appears.
4. Whether the product skill and RedSkills' `dev:diagnose` overlap enough to
   share text — decide when writing the skill.

## Recommended Next Steps

1. `/to-spec` on this session: the natural vertical slices are (i) the
   semantic-action schema + `red-dev keys`, (ii) default agent + product skill
   + `agents update`, (iii) agent usage on Redwall/doctor with the Claude
   collector, (iv) Panels network/DNS first, (v) web apps wired + catalogue
   symmetry, (vi) user layer for zellij, (vii) emoji picker, (viii) SSH keys
   from GitHub.
2. Fix the two README drifts (web apps, ble.sh) as part of (v) and separately.
3. Run `/wiki-init`, then re-ingest the transcript and the repository at
   `7be59e1f` so the next Quattro comparison starts cached.
