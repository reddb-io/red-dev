/**
 * The single place where "what to install" lives.
 *
 * This is data, but typed data: a malformed provider is a compile error
 * rather than a runtime surprise. That matters more than it sounds —
 * the bug that motivated this project was a provider URL that was wrong
 * for months without anything failing loudly.
 */

import { existsSync } from "node:fs";
import { RedError } from "./log.ts";
import { commandExists, versionAtLeast, type Platform } from "./platform.ts";

export type Scope =
  /** Every target. This is the identical-experience layer. */
  | "core"
  /** Bare-metal Ubuntu only: GUI apps, GNOME settings. */
  | "desktop"
  /** WSL only: runs in the distro but acts on the Windows host. */
  | "wsl"
  /**
   * Never installed by a plain converge — only when explicitly chosen.
   *
   * omakub asks which optional apps you want at first run. The same idea
   * needs a scope of its own here rather than a flag on each tool,
   * because `install` must stay non-interactive: it runs in CI and in
   * scripts, where a prompt is a hang.
   */
  | "optional";

/**
 * The provider shapes, before the flags that apply to all of them.
 *
 * Split from `Provider` so a cross-cutting flag is declared once instead
 * of being repeated on nine members and forgotten on the tenth.
 */
type ProviderSpec =
  | { kind: "apt"; pkg: string }
  | { kind: "winget"; id: string }
  /**
   * A tool mise owns end to end: version resolution, download, checksum
   * and the shim that puts it on PATH.
   *
   * The provider that made this necessary is `gh` directly above it,
   * which does the same job by hand — resolve a release, glob an asset,
   * fetch it, place it. That is the right answer for a third party whose
   * releases we only consume. It is the wrong one for our own suite,
   * because it downloads a tool *once* and there is nothing left that
   * knows how to move it forward; every reddb-io tool grew an install.sh
   * and none of them grew an updater.
   *
   * mise's `github:` backend needs nothing from the repository being
   * installed — it reads the release assets and scores them by OS,
   * architecture, libc and format. What it gives back is the part `gh`
   * never had: `mise outdated` and `mise upgrade` over the whole suite,
   * plus attestation and SLSA verification where the publisher emits
   * them, which ours do.
   *
   * That argument is not special to our own releases, and limiting the
   * provider to them lasted exactly as long as it took to read the rest
   * of the manifest: every `gh` tool had the same frozen-forever
   * problem, because a converge that finds a binary on PATH never asks
   * how old it is. So mise owns the Linux half of the third-party
   * releases too, through its registry wherever the registry has them.
   *
   * `gh` stays where mise would be wrong rather than merely
   * unnecessary: an asset that is an installer rather than a binary
   * (red-request on Windows), and a release whose supported artifact is
   * a .deb carrying desktop integration that a bare relocatable binary
   * would shadow (red-ui).
   *
   * winget stays on Windows. `winget upgrade --all` already refreshes
   * what it owns, so mise there would be replacing a working updater
   * rather than supplying the missing one.
   */
  | {
      kind: "mise";
      /** Backend-qualified: "github:reddb-io/reddb". */
      spec: string;
      /**
       * The name a person types, wired through [tool_alias].
       *
       * Nearly always required, because a repository name and the binary
       * inside it are different facts: reddb-io/toon ships `tq`.
       */
      alias?: string;
      /** A mise selector. Absent means "latest". */
      version?: string;
    }
  /**
   * The vendor's own install script, fetched and run.
   *
   * Preferred over npm for the tools whose publisher treats this as the
   * supported path: npm 11 gates postinstall scripts by default, and
   * several of them fetch the platform binary in exactly that hook —
   * which installs cleanly and leaves a command that does not work.
   *
   * `args` is passed to the script. red-request's takes --deb/--appimage
   * and --no-color, and a converge that inherits stdout wants the last
   * one whether or not the script's own TTY detection would have found
   * it.
   */
  | { kind: "installer"; url: string; note: string; args?: string[] }
  /**
   * Resolve a release asset by *matching a glob against the names the
   * release actually has*, never by building a filename from a pinned
   * version. omakub-wsl pins gum to 0.14.1 but fetches from
   * /releases/latest/download/, so the path resolves to today's release
   * while the filename still says 0.14.1 — a guaranteed 404 the moment
   * upstream ships anything new. Matching real names fails loudly with
   * the available candidates instead.
   */
  | {
      kind: "gh";
      repo: string;
      asset: string;
      /**
       * Hold this repo at one release instead of following /latest.
       *
       * For the case a glob cannot express: not "which file in the
       * newest release", but "not the newest release at all", because a
       * later one is the defect. zellij 0.44.2 shipped the OSC-reply
       * leak and there is no filename that says so.
       *
       * The *tag*, as the publisher writes it — `v0.44.1`, not `0.44.1`,
       * for a repo that tags with a prefix. It is used verbatim, since
       * decorating it is a guess and a guess here is a 404 on the next
       * repo that tags the other way. Absent, resolution is exactly what
       * it always was: /releases/latest, glob matched against the names
       * that release publishes.
       *
       * Half a pin on its own. The tool it belongs to also needs
       * `pinVersion`, or a machine that already carries a later build
       * is never told — see Tool.pinVersion.
       */
      version?: string;
      /**
       * Install name, when the release publishes a bare binary whose
       * asset name is not the command. tealdeer ships
       * `tealdeer-linux-x86_64-musl` and the command is `tldr`.
       */
      bin?: string;
      /**
       * Windows only: the asset is an installer, and these are the flags
       * that make it run unattended.
       *
       * Present rather than guessed from the filename. `tq-windows-x86_64.exe`
       * is a binary and `red-request-windows-x86_64-setup.exe` is an
       * installer, and the only thing separating them is a naming
       * convention the publisher is free to change.
       */
      silentArgs?: string[];
    }
  /** A Launchpad PPA, then apt. */
  | { kind: "ppa"; ppa: string; pkgs: string[] }
  /**
   * A third-party apt repository: fetch the signing key, write the
   * sources entry, then apt. `entry` may contain {{codename}}, which is
   * substituted with the running release — the same definition then
   * works on 24.04 and 26.04 instead of needing one script per version.
   */
  | {
      kind: "aptrepo";
      pkgs: string[];
      keyUrl: string;
      keyring: string;
      entry: string;
      /** Add the invoking user to this group after install (docker). */
      group?: string;
    }
  /** Implemented in TypeScript, in this binary. */
  | {
      kind: "builtin";
      name:
        | "nerd-font"
        | "windows-terminal"
        | "dotfiles"
        | "alacritty"
        | "wsl-interop"
        | "wsl-runtime-dir"
        | "blesh"
        | "runtimes"
        | "shared-root"
        | "hotkeys"
        | "red-skills"
        | "red-skills-vscode"
        | "red-skills-herdr"
        | "blender"
        | "wsl-sync"
        | "codex-statusline"
        | "claude-keybindings"
        | "redwall-hook"
        | "puppeteer"
        | "ssh-server";
    }
  /** Not installed here, deliberately. The reason is required. */
  | { kind: "skip"; reason: string };

/** One column of the manifest: how this platform gets this tool. */
export type Provider = ProviderSpec & {
  /**
   * This Linux provider eventually invokes sudo.
   *
   * The common package shapes (apt, PPA, apt repository and .deb release)
   * imply this themselves. This flag exists for installers and builtins whose
   * script body is the only other place the requirement could be discovered —
   * too late to authenticate before the fullscreen renderer owns stdin.
   */
  needsSudo?: true;
  /**
   * This column cannot complete without administrator rights.
   *
   * Declared per column, never per tool, because the need is not
   * symmetrical. The Windows OpenSSH server is a capability to add, a
   * service to set Automatic and a firewall rule to open — three
   * administrator operations — while the same item on Ubuntu is an apt
   * package taking the ordinary sudo path. A Linux target must not be
   * asked to elevate for a Windows requirement.
   *
   * Data, so `plan` can answer "will this ask for administrator" without
   * executing anything, and so a test can name the set on each target
   * with no Windows host in sight.
   *
   * `true` only. Absence is the answer for everything else, and a
   * `needsAdmin: false` sprinkled through the manifest would read as a
   * checked claim where it is only the default.
   */
  needsAdmin?: true;
};

export interface Tool {
  /** Stable logical name — what the user thinks they have. */
  name: string;
  /** One line shown when offering this tool in a selection list. */
  about?: string;
  /**
   * Binaries to probe. Debian renames several of these (ripgrep -> rg,
   * bat -> batcat, fd-find -> fdfind) while Windows and upstream keep
   * the plain name, so probing must accept either. The shell aliases
   * are what make the *experience* identical; this only answers
   * "is it already here".
   */
  cmd?: string[];
  /**
   * A file whose existence is the proof, for packages that ship no
   * binary at all.
   *
   * Every probe above answers "is there a command on PATH", which is the
   * right question for all but one shape of package. bash-completion
   * installs a shell library and nothing executable, so probing by name
   * asked for `bash-completion` on PATH, never found it, and reported
   * the package absent on a machine where dpkg said `install ok
   * installed`. The converge then tried to install it on every run,
   * forever, and each run named it as a problem.
   *
   * The path is the same one the code that consumes the package already
   * reads, which is what keeps this honest: a declaration pointing
   * somewhere nothing uses would pass its own test and prove nothing.
   */
  file?: string;
  /**
   * Proof that the command on PATH is the tool we mean.
   *
   * A name is not an identity. Ubuntu ships /usr/bin/red — GNU ed's
   * restricted mode — so probing for `red` found it, reported the RedDB
   * CLI as present, and the real one was never installed on any Linux
   * machine. The doctor said `ok red` about GNU ed 1.20.1.
   *
   * Only needed where a name genuinely collides; everywhere else the
   * name is enough and running every tool to ask its version would cost
   * a process per check.
   */
  signature?: RegExp;
  /**
   * Below this, present is not installed.
   *
   * Probing for a name answers "is something here", which is the wrong
   * question whenever the archive ships a version the rest of the stack
   * has moved past. noble's neovim is 0.9.5; LazyVim refuses to start
   * under 0.11.2 and exits with a message. Since red-dev also sets
   * EDITOR=nvim, that is not a degraded editor, it is every caller of
   * $EDITOR broken — and converge reported `present` on every run,
   * because a binary was there.
   *
   * Only worth declaring where a floor is known and enforced by
   * something downstream. Compared numerically, segment by segment; no
   * prerelease ordering, because no tool here needs it.
   */
  minVersion?: string;
  /**
   * This version, exactly. Newer is also wrong.
   *
   * The floor above answers "is this new enough", which is the wrong
   * question whenever a *later* release is the defect — and a floor is
   * then silent on precisely the machine that has the bad build. zellij
   * 0.44.2 introduced the OSC-reply leak; a floor of 0.44.1 calls a host
   * running 0.44.3 `ok` and the terminal keeps filling with replies.
   *
   * So a pin is a point, not a range: any other version is reported as
   * `mismatched` and the report names both numbers. Downgrading is left
   * to the provider — on a `gh` column that follows, because the tag is
   * declared there too; on a column whose package manager only moves
   * forward it does not, and saying so out loud beats a doctor that
   * reports `ok` about the version we know is broken.
   *
   * Declared with the reason and the condition for lifting it written
   * beside the tool. A pin whose justification is lost is a pin nobody
   * dares remove, and it outlives the bug by years.
   */
  pinVersion?: string;
  scope: Scope;
  /**
   * True when presence cannot be answered by probing for a command —
   * a font, a settings file. The provider owns the check and is
   * idempotent, so `install` always calls it and it decides whether
   * there is work to do. Reporting these as "missing" forever, which
   * a command probe would, is worse than useless.
   */
  managed?: boolean;
  u24: Provider;
  /** Omit when identical to u24. */
  u26?: Provider;
  win: Provider;
}

const apt = (pkg: string): Provider => ({ kind: "apt", pkg });
const winget = (id: string): Provider => ({ kind: "winget", id });
const gh = (repo: string, asset: string, bin?: string): Provider => ({
  kind: "gh",
  repo,
  asset,
  ...(bin ? { bin } : {}),
});
/**
 * A tool mise resolves, downloads and keeps current.
 *
 * `spec` is either a registry name (`starship`) or a backend-qualified
 * one (`github:reddb-io/toon`). The registry is preferred wherever it
 * has the tool: its entries resolve through aqua, which carries the
 * publisher's own checksums, and they are maintained by people who
 * watch the release feeds. `github:` is the escape hatch for what the
 * registry does not know — our repositories, and our forks.
 *
 * The options ride in an object rather than as positional arguments
 * because `alias` and `version` are independent and mostly absent, and
 * a call site reading mise("github:reddb-io/toon", "tq") gives no clue
 * which of the two that string is.
 */
const mise = (
  spec: string,
  opts: { alias?: string; version?: string } = {},
): Provider => ({
  kind: "mise",
  spec,
  ...(opts.alias ? { alias: opts.alias } : {}),
  ...(opts.version ? { version: opts.version } : {}),
});
/** A release asset that is an installer rather than a binary. */
const ghInstaller = (repo: string, asset: string, ...silentArgs: string[]): Provider => ({
  kind: "gh",
  repo,
  asset,
  silentArgs,
});
const installer = (url: string, note: string, ...args: string[]): Provider => ({
  kind: "installer",
  url,
  note,
  ...(args.length > 0 ? { args } : {}),
});
const ppa =(name: string, ...pkgs: string[]): Provider => ({
  kind: "ppa",
  ppa: name,
  pkgs,
});
const aptrepo = (spec: {
  pkgs: string[];
  keyUrl: string;
  keyring: string;
  entry: string;
  group?: string;
}): Provider => ({ kind: "aptrepo", ...spec });
const builtin = (
  name:
    | "nerd-font"
    | "windows-terminal"
    | "dotfiles"
    | "alacritty"
    | "wsl-interop"
    | "wsl-runtime-dir"
    | "wsl-sync"
    | "blesh"
    | "runtimes"
    | "shared-root"
    | "hotkeys"
    | "red-skills"
    | "red-skills-vscode"
    | "red-skills-herdr"
    | "blender"
    | "codex-statusline"
    | "claude-keybindings"
    | "redwall-hook"
    | "puppeteer"
    | "ssh-server",
): Provider => ({ kind: "builtin", name });
const skip = (reason: string): Provider => ({ kind: "skip", reason });
/** A Linux provider whose implementation performs system work through sudo. */
const sudoProvider = (pr: ProviderSpec): Provider => ({ ...pr, needsSudo: true });
/**
 * Wraps a column that cannot complete without administrator rights.
 *
 * A wrapper rather than a field on every helper, so the declaration
 * reads as what it is at the call site — `admin(builtin("ssh-server"))`
 * says the Windows column needs rights and the row above it does not.
 */
const admin = (pr: ProviderSpec): Provider => ({ ...pr, needsAdmin: true });

const NO_GUI = "no GUI layer on this target";
const HOST_PROVIDES = "the Windows host provides this instead";

export const TOOLS: Tool[] = [
  // ---------------------------------------------------------- core
  {
    // First in the list, and that position is load-bearing rather than
    // alphabetical. mise owns the language runtimes and now also every
    // tool this organisation publishes, so a converge that reached `tq`
    // or `red` before installing mise would fail on a machine where the
    // only thing wrong was the order we wrote things down in.
    //
    // Nothing else in core depends on a peer, which is why this is the
    // only entry that has to say so.
    name: "mise",
    scope: "core",
    u24: aptrepo({
      pkgs: ["mise"],
      keyUrl: "https://mise.jdx.dev/gpg-key.pub",
      keyring: "/etc/apt/keyrings/mise-archive-keyring.gpg",
      entry:
        "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.gpg arch=amd64] https://mise.jdx.dev/deb stable main",
    }),
    win: winget("jdx.mise"),
  },
  {
    // red-dev itself, which until now had no way to move forward.
    //
    // boot.sh fetches a binary into ~/.local/bin and that was the end of
    // the story: `red-dev update` upgraded apt, winget, the suite and
    // the agents, and left the thing doing the upgrading frozen at
    // whatever the last bootstrap fetched. Re-running the one-liner was
    // the only path, which is a strange thing to ask of a tool whose
    // entire subject is keeping a machine current.
    //
    // What blocked it was never the line below; it was that a machine
    // which had run both boot.sh and mise would carry two copies with
    // PATH order picking the winner, so `mise upgrade` could report
    // success having updated the copy nobody runs. That ordering is now
    // decided rather than left to chance: config/bash/path.sh puts
    // mise's shims ahead of ~/.local/bin, and the 2026-08-15 migration
    // removes the bootstrap copy once mise can answer for it.
    //
    // Deliberately left at mise's default release age rather than
    // MISE_MINIMUM_RELEASE_AGE=0: a release published minutes ago is
    // exactly the one nobody has run yet, and a short wait before the
    // fleet takes it is the same argument Omarchy makes for a mirror
    // that trails. It means `red-dev update` will not fetch a tag cut
    // today, which is a trade rather than a bug.
    name: "red-dev",
    about: "this tool, kept current by the same mechanism as everything else",
    scope: "core",
    u24: mise("github:reddb-io/red-dev", { alias: "red-dev" }),
    win: mise("github:reddb-io/red-dev", { alias: "red-dev" }),
  },
  { name: "git", scope: "core", u24: apt("git"), win: winget("Git.Git") },
  { name: "curl", scope: "core", u24: apt("curl"), win: winget("cURL.cURL") },
  {
    name: "unzip",
    scope: "core",
    u24: apt("unzip"),
    win: skip("Windows expands archives natively"),
  },
  {
    name: "ripgrep",
    cmd: ["rg"],
    scope: "core",
    u24: apt("ripgrep"),
    win: winget("BurntSushi.ripgrep.MSVC"),
  },
  {
    name: "fd",
    cmd: ["fdfind", "fd"],
    scope: "core",
    u24: apt("fd-find"),
    win: winget("sharkdp.fd"),
  },
  {
    name: "bat",
    cmd: ["batcat", "bat"],
    scope: "core",
    u24: apt("bat"),
    win: winget("sharkdp.bat"),
  },
  { name: "eza", scope: "core", u24: apt("eza"), win: winget("eza-community.eza") },
  {
    // A service, not a binary, which is why it is a builtin on both
    // columns rather than apt on one and winget on the other: `apt
    // install openssh-server` leaves nothing running on a WSL without
    // systemd, and Windows has no package for it at all — OpenSSH
    // Server is a capability, its service is created stopped and set to
    // Manual, and the firewall blocks 22 until told otherwise.
    //
    // `core`, so every converge opens the port. That is a deliberate
    // decision rather than an oversight; src/ssh-server.ts says what it
    // costs, and the converge logs it instead of a silent ok.
    //
    // The Windows column is the manifest's first `admin`, and adding the
    // item is what made the declaration necessary: until it arrived, no
    // red-dev converge had ever needed administrator, and the run that
    // discovered otherwise did so at the item itself — a warning buried
    // in a summary that still reported success. Ubuntu keeps the plain
    // column: apt-get through sudo is the path every other package here
    // already takes.
    name: "ssh-server",
    scope: "core",
    managed: true,
    u24: sudoProvider(builtin("ssh-server")),
    win: admin(builtin("ssh-server")),
  },
  {
    // Sourced by config/bash/init.sh since before it was ever declared
    // here, which is the whole reason it is now. It arrives as somebody
    // else's dependency on a desktop Ubuntu, so the guard around the
    // source line never fired and the gap stayed invisible — until a
    // trimmed WSL image or a container, where nothing pulls it in and
    // bash loses tab-completion for git, apt, ssh and the rest without
    // saying so.
    //
    // No `win`: Git Bash carries its own copy, and there is no winget
    // package that would put one where MSYS bash reads from.
    name: "bash-completion",
    scope: "core",
    // The file config/bash/init.sh sources, which is the only observable
    // this package leaves behind — it installs no binary, so the default
    // name-on-PATH probe reported it absent forever and every converge
    // tried to install it again.
    file: "/usr/share/bash-completion/bash_completion",
    u24: apt("bash-completion"),
    win: skip("Git Bash ships its own bash-completion"),
  },
  { name: "zoxide", scope: "core", u24: apt("zoxide"), win: winget("ajeetdsouza.zoxide") },
  { name: "fzf", scope: "core", u24: apt("fzf"), win: winget("junegunn.fzf") },
  { name: "btop", scope: "core", u24: apt("btop"), win: winget("aristocratos.btop4win") },
  { name: "jq", scope: "core", u24: apt("jq"), win: winget("jqlang.jq") },
  {
    // config/bash/functions.sh ships webm2mp4, and that helper is only
    // honest if the binary it shells out to is part of the base toolset.
    name: "ffmpeg",
    scope: "core",
    u24: apt("ffmpeg"),
    win: winget("Gyan.FFmpeg"),
  },
  {
    // Beside jq rather than instead of it: the same shape of tool for a
    // different format, and the reason it is core is that a data tool
    // you cannot rely on being present is one you stop reaching for.
    //
    // The repository is `toon` and the binary is `tq`, which is why the
    // alias is not decoration: without it mise would expose this as
    // `toon`, and `toon --version` answering "tq 0.28.2" is the kind of
    // small wrongness nobody reports and everybody trips on.
    name: "tq",
    about: "query and convert TOON, the token-oriented notation",
    scope: "core",
    u24: mise("github:reddb-io/toon", { alias: "tq" }),
    win: mise("github:reddb-io/toon", { alias: "tq" }),
  },
  {
    // The database this whole organisation is named after, and the one
    // tool here whose absence would be strange. A CLI, so core: it is
    // the same binary on the desktop, in WSL and on Windows.
    //
    // `red`, not `red_client` — the release publishes both, plus a
    // -static variant of each, and only the first is the command people
    // run. mise picks it on its own: verified against the real 1.23.2
    // release, which it resolved to red-linux-x86_64 with the build
    // attestation checked.
    name: "red",
    about: "the RedDB CLI — embedded, server, cluster",
    // The name collides with GNU ed's restricted mode, which Ubuntu
    // installs at /usr/bin/red. Without this the probe found that,
    // called it present, and the RedDB CLI never installed at all.
    signature: /reddb/i,
    scope: "core",
    u24: mise("github:reddb-io/reddb", { alias: "red" }),
    win: mise("github:reddb-io/reddb", { alias: "red" }),
  },

  // The bash answer to what people actually want from oh-my-zsh.
  // Every one of these is cross-shell and cross-platform, which is why
  // they belong in core rather than in a Linux-only corner.
  {
    name: "starship",
    scope: "core",
    // Registry rather than github:, here and for the six below it. The
    // registry entry resolves through aqua, which knows the upstream
    // checksum file — the asset glob this carried before verified
    // nothing beyond "a file with that name existed".
    u24: mise("starship"),
    win: winget("Starship.Starship"),
  },
  {
    name: "atuin",
    scope: "core",
    u24: mise("atuin"),
    win: winget("Atuinsh.Atuin"),
  },
  {
    name: "carapace",
    scope: "core",
    // The .deb this replaces was the one asset here that needed root to
    // unpack; the registry hands over a binary instead, so carapace
    // stops being a reason for a converge to ask for sudo.
    u24: mise("carapace"),
    win: winget("rsteube.Carapace"),
  },
  { name: "direnv", scope: "core", u24: apt("direnv"), win: winget("direnv.direnv") },
  {
    // Every git diff, show and log -p goes through this, and lazygit
    // picks it up too. The single largest quality change per byte
    // installed.
    name: "delta",
    scope: "core",
    u24: apt("git-delta"),
    win: winget("dandavison.delta"),
  },
  {
    // Not in the 24.04 archive; the release tarball is the only route.
    name: "yazi",
    scope: "core",
    u24: mise("yazi"),
    win: winget("sxyazi.yazi"),
  },
  {
    // Not apt. The archive ships tealdeer 1.6.1 from 2023, which points
    // at a page-cache URL whose format has since changed: every
    // `tldr --update` fails with "Could not find central directory end",
    // leaving a binary that answers every query with "Page cache not
    // found". A tool that cannot fetch its own data is not installed in
    // any sense that matters.
    name: "tldr",
    cmd: ["tldr"],
    scope: "core",
    // The one tool here that stays on gh, and the reason is the third
    // argument: the release ships a binary called `tealdeer` and the
    // command people type is `tldr`. gh renames it on the way in. mise
    // cannot — neither the github: backend nor ubi's `exe=` option
    // renames the extracted file, both verified against the real 1.8.1
    // release, and a shim called `tealdeer` is a `tldr` that does not
    // exist. Revisit if the registry ever adopts it.
    u24: gh("dbrgn/tealdeer", "tealdeer-linux-x86_64-musl", "tldr"),
    win: winget("dbrgn.tealdeer"),
  },
  {
    name: "fastfetch",
    scope: "core",
    // Not in the 24.04 archive. The PPA publishes per-suite, so this is
    // unverified on 26.04 — no 26.04 target has run yet.
    u24: ppa("zhangsongcui3371/fastfetch", "fastfetch"),
    win: winget("Fastfetch-cli.Fastfetch"),
  },
  {
    name: "gh",
    scope: "core",
    u24: aptrepo({
      pkgs: ["gh"],
      keyUrl: "https://cli.github.com/packages/githubcli-archive-keyring.gpg",
      keyring: "/usr/share/keyrings/githubcli-archive-keyring.gpg",
      entry:
        "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main",
    }),
    win: winget("GitHub.cli"),
  },
  {
    name: "lazygit",
    scope: "core",
    u24: mise("lazygit"),
    win: winget("JesseDuffield.lazygit"),
  },
  {
    name: "lazydocker",
    scope: "core",
    u24: mise("lazydocker"),
    // Capital L. winget's --exact is case-sensitive, and the lowercase
    // form exits 20 ("no package found") -- which this reported as a
    // successful install for as long as non-zero was only a warning.
    win: winget("JesseDuffield.Lazydocker"),
  },
  {
    // zellij is how tiling stays identical across all five targets.
    // Alacritty deliberately has no panes, and the platform-native
    // answers diverge completely — GNOME extensions on Linux,
    // FancyZones on Windows. A multiplexer sidesteps that: the same
    // panes, tabs, sessions and keybindings everywhere.
    //
    // Upstream ships an official windows-msvc build (0.44.3 has both a
    // .zip and an .msi), which an earlier revision of this manifest
    // wrongly claimed did not exist.
    //
    // Installed from the reddb-io fork, not upstream. 0.44.2 began
    // answering the terminal's OSC queries without consuming the
    // replies, so they land in the pane as literal text — `11;rgb:...`
    // sprayed across whatever is running. That is zellij-org/zellij#5174;
    // upstream main carries the fix but has never released it. The fork
    // is v0.44.3 plus that fix backported (branch red/0.44), which keeps
    // the 0.44.2+ features an earlier 0.44.1 pin gave up. Its releases
    // publish binaries only — nothing goes to crates.io.
    //
    // The pin has four segments because the fork versions as
    // 0.44.3+red.1 — see parseVersion, which folds the `red.N` marker
    // into a fourth segment for both the binary and the tag spellings.
    //
    // Lift the fork when an upstream release ships the fix for #5174:
    // point repo, tag and pin back at zellij-org and drop the fourth
    // segment together.
    name: "zellij",
    scope: "core",
    pinVersion: "0.44.3.2",
    // Pinned through mise rather than by hand. The fork is ours and the
    // registry carries only upstream, so this is the github: backend —
    // and the version here is the tag, `0.44.3-red.2`, while pinVersion
    // above is what the binary answers to --version, `0.44.3.2`. They
    // name the same release in the two vocabularies that ask.
    //
    // A pinned tool is the one case where `mise upgrade` must move
    // nothing, and it moves nothing: the selector is exact, so upgrade
    // resolves it to itself.
    u24: mise("github:reddb-io/zellij", { alias: "zellij", version: "0.44.3-red.2" }),
    // winget installs upstream's newest — so on Windows the pin is a
    // report rather than a repair: the doctor names the machine as off
    // the pinned version and the swap is manual. The fork's release
    // does ship a windows-msvc .zip and .msi for exactly that swap.
    // Silence would be the alternative, and silence is how 0.44.3 got
    // onto a machine in the first place.
    win: winget("Zellij.Zellij"),
  },
  {
    name: "neovim",
    cmd: ["nvim"],
    // LazyVim's own floor. Below it nvim starts, prints "LazyVim
    // requires Neovim >= 0.11.2" and exits.
    minVersion: "0.11.2",
    scope: "core",
    // The archive ships 0.9.5 on noble, and LazyVim refuses to start on
    // it — it requires 0.11.2 or newer and exits with a message. Since
    // red-dev also sets EDITOR=nvim, an archive nvim does not degrade
    // the editor, it breaks every caller of $EDITOR: git commit, zellij's
    // EditScrollback, Claude Code's external editor. The upstream tarball
    // is not a drop-in either: nvim needs its runtime tree, so installing
    // just the binary produces a broken editor. The PPA packages both
    // properly.
    u24: ppa("neovim-ppa/unstable", "neovim"),
    win: winget("Neovim.Neovim"),
  },
  {
    name: "docker",
    scope: "core",
    u24: aptrepo({
      pkgs: [
        "docker-ce",
        "docker-ce-cli",
        "containerd.io",
        "docker-buildx-plugin",
        "docker-compose-plugin",
      ],
      keyUrl: "https://download.docker.com/linux/ubuntu/gpg",
      keyring: "/etc/apt/keyrings/docker.asc",
      entry:
        "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu {{codename}} stable",
      // Without this, every docker command needs sudo — which is not
      // the experience anyone means by "docker is installed".
      group: "docker",
    }),
    win: winget("Docker.DockerDesktop"),
  },

  // Last in core on purpose: aliases.sh probes for what actually got
  // installed (batcat vs bat, eza present or not), so it has to run
  // after the tools above, not before them.
  //
  // Native Windows gets the same files: Git Bash runs them unchanged,
  // which is why standardising on bash rather than PowerShell is what
  // makes "same experience" true instead of aspirational.
  {
    name: "dotfiles",
    scope: "core",
    managed: true,
    u24: builtin("dotfiles"),
    win: builtin("dotfiles"),
  },
  {
    name: "alacritty-config",
    scope: "core",
    managed: true,
    u24: builtin("alacritty"),
    win: builtin("alacritty"),
  },
  // Coding agents moved to src/agents.ts. They sat in this scope, which
  // meant every machine got all three whether or not anyone wanted
  // them — unconditional is not the same as chosen. The setup offers
  // every applicable agent pre-ticked so the user can opt out, and
  // choosing any of them pulls in red-skills to wire them up.
  {
    // Installing mise without using it leaves the machine with a
    // version manager and no versions — which is how `pnpm` ends up
    // resolving in one shell and not another on the same box.
    name: "runtimes",
    scope: "core",
    managed: true,
    u24: builtin("runtimes"),
    win: builtin("runtimes"),
  },
  {
    // On by default; RED_BLE=0 opts out. See the note in src/blesh.ts
    // for how the trial that earned the default played out.
    name: "blesh",
    scope: "core",
    managed: true,
    u24: builtin("blesh"),
    win: builtin("blesh"),
  },

  // ------------------------------------------------------- desktop
  // The honest boundary of "same experience": these exist on bare-metal
  // Ubuntu and nowhere else.
  {
    name: "gnome-tweaks",
    scope: "desktop",
    u24: apt("gnome-tweaks"),
    win: skip(NO_GUI),
  },
  {
    name: "alacritty",
    scope: "desktop",
    u24: apt("alacritty"),
    win: winget("Alacritty.Alacritty"),
  },
  { name: "flatpak", scope: "desktop", u24: apt("flatpak"), win: skip(NO_GUI) },
  {
    // Zellij's configured copy command targets wl-copy on real Linux
    // desktops. WSL and native Windows use their own clipboard bridges.
    name: "wl-clipboard",
    scope: "desktop",
    u24: apt("wl-clipboard"),
    win: skip(NO_GUI),
  },
  {
    // A GUI app, so `desktop` — which also means WSL never attempts it,
    // because applicableScopes gates that scope on caps.gui. That is the
    // right answer rather than an omission: a Linux GUI app installed
    // inside a distro with no display is the exact mistake this project
    // exists to avoid, and the Windows target already installs it for
    // the same machine.
    //
    // Two different routes on purpose. On Linux the publisher's own
    // install.sh is the supported path — it verifies the asset against
    // checksums.txt, writes the .desktop entry, adds the `rr` shortcut
    // and knows how to upgrade itself, none of which dropping the .deb
    // in by hand would do. On Windows that same script says it "hands
    // the installer to you to open", so a converge cannot use it; the
    // release asset runs unattended instead.
    // Deliberately not a mise tool, unlike the CLIs above.
    //
    // mise can install this — it resolves the release and picks the
    // AppImage on its own. That is exactly the problem. The project
    // ships a .deb *and* an AppImage and treats the .deb as the
    // supported path, because it links the system WebKitGTK rather than
    // bundling one; the installer even detects an AppImage sitting in
    // ~/.local/bin and deletes it, because it shadows the .deb on PATH
    // (red-request/install.sh:326). Pointing mise at this repo would
    // reintroduce, on every converge, the exact state the vendor script
    // exists to clean up — and lose the .desktop entry, the icon and
    // the `rr` shortcut with it.
    //
    // Revisit if upstream ever publishes a plain relocatable binary.
    name: "red-request",
    about: "open-source API client, powered by recker",
    cmd: ["red-request", "rr"],
    scope: "desktop",
    u24: sudoProvider(
      installer(
        "https://raw.githubusercontent.com/reddb-io/red-request/main/install.sh",
        "reddb-io/red-request — installs the .deb and verifies its checksum",
        "--no-color",
      ),
    ),
    // /S is NSIS's silent flag, and this asset really is NSIS: its PE
    // manifest asks for asInvoker, so it installs per-user with no UAC
    // prompt. Checked against the published binary rather than inferred
    // from Tauri's defaults.
    win: ghInstaller("reddb-io/red-request", "red-request-windows-x86_64-setup.exe", "/S"),
  },
  {
    // The other RedDB desktop app. Same shape as red-request: Linux
    // takes the deb, while Windows consumes the published installer
    // asset directly so a clean native Windows converge gets the app.
    //
    // The glob carries a wildcard where the version goes:
    // red-ui_0.1.0_amd64.deb. Anchoring it to today's version is exactly
    // the 404-on-next-release bug documented on the provider.
    // Not a mise tool, for the same reason as red-request directly
    // above: the .deb carries the desktop integration and the `red`
    // sidecar, and an AppImage on PATH shadows it (red-ui/install.sh:293).
    name: "red-ui",
    about: "universal client for reddb — embedded, server, docker, cluster",
    scope: "desktop",
    u24: gh("reddb-io/red-ui", "red-ui_*_amd64.deb"),
    win: ghInstaller("reddb-io/red-ui", "red-ui-windows-x86_64-setup.exe", "/S"),
  },
  {
    // A CLI, and still `desktop` rather than `core`, because what it
    // does is type into the focused application. Under WSL there is no
    // focused application to type into and no /dev/input to read the
    // hotkey from — the binary would install cleanly and do nothing,
    // which is the outcome this project exists to avoid.
    //
    // The publisher's installer on Linux, not the bare binary, and for
    // once that is not about checksums. dit reads its hotkey from
    // /dev/input and types through /dev/uinput, so it needs you in the
    // `input` group and a udev rule; dropping the binary in gives you a
    // program that runs and cannot see a keypress. install.sh sets both
    // up. --yes keeps a converge non-interactive, and --no-service
    // leaves the autostart unit alone: a standing background service is
    // a decision to make deliberately, and dit works without it.
    //
    // Windows needs no equivalent — SendInput requires no permissions —
    // so the release binary is enough there.
    name: "dit",
    about: "push-to-toggle voice dictation, typed into the focused app",
    scope: "desktop",
    // Split on purpose, and the split is the whole point of keeping two
    // providers around.
    //
    // Linux stays on the vendor installer because the binary is the
    // smaller half of what it does: dit reads the hotkey from
    // /dev/input and types through /dev/uinput, so it also adds the
    // user to the `input` group and writes the uinput udev rule
    // (dit/install.sh:339-361). mise would deliver a binary that runs
    // and never types — working software by every check we could make,
    // and useless.
    u24: sudoProvider(
      installer(
        "https://raw.githubusercontent.com/reddb-io/dit/main/install.sh",
        "reddb-io/dit — installs the binary and the /dev/uinput permissions it needs",
        "--yes",
        "--no-service",
      ),
    ),
    // Windows has no such requirement — it was a plain release asset
    // already, so here mise is a straight gain: the same download, plus
    // an updater.
    win: mise("github:reddb-io/dit", { alias: "dit" }),
  },

  // ------------------------------------------------------ optional
  // Chosen, never assumed. `red-dev apps` offers these; a plain
  // converge ignores them entirely.
  {
    name: "puppeteer",
    about: "browser automation CLI + Chrome for Testing + Ubuntu libraries — about 280 MB",
    cmd: ["puppeteer"],
    scope: "optional",
    managed: true,
    u24: sudoProvider(builtin("puppeteer")),
    win: builtin("puppeteer"),
  },
  {
    // Microsoft's own, and the closest Windows gets to the desktop half
    // of omakub. FancyZones is the analogue of tactile — a keyboard-
    // driven window grid — and Command Palette is the analogue of the
    // Ulauncher omakub binds to Super+Space.
    //
    // Optional rather than desktop, because it is a program that stays
    // running. Offering it is right; installing it as part of a theme
    // switch is not, which is why nothing else here reaches for it.
    //
    // Windows only, and that falls out of the provider rather than being
    // asserted: there is no Linux PowerToys to skip toward.
    name: "powertoys",
    about: "FancyZones window tiling, launcher, key remapping — Microsoft's own",
    // A location, not a name: PowerToys never touches PATH.
    cmd: ["%LOCALAPPDATA%\\PowerToys\\PowerToys.exe"],
    scope: "optional",
    u24: skip("PowerToys is Windows-only; zellij is the tiling answer here"),
    win: winget("Microsoft.PowerToys"),
  },
  {
    // A builtin rather than a provider, because Blender fits none of
    // them: apt has 4.0.2 against winget's 5.2.0 and a .blend written by
    // one will not open in the other, and `gh` reads neither .tar.xz nor
    // a 1.2 GB tree that has to stay whole. src/blender.ts says the
    // rest.
    name: "blender",
    about: "3D creation suite — 1.2 GB, the official build",
    scope: "optional",
    managed: true,
    u24: builtin("blender"),
    win: winget("BlenderFoundation.Blender"),
  },
  {
    // Both come from the artifacts RedSkills already publishes: the
    // `.vsix` and the plugin bundle are attached to every release, so
    // neither needs a checkout, a pnpm install, or a build here. That is
    // also the only way they can still be installed — the published
    // package stopped carrying monorepo source.
    name: "red-skills-vscode",
    about: "RedSkills panel for VS Code — the published .vsix",
    scope: "optional",
    managed: true,
    u24: builtin("red-skills-vscode"),
    win: builtin("red-skills-vscode"),
  },
  {
    name: "red-skills-herdr",
    about: "RedSkills plugin for herdr — live workers, logs and PRs",
    scope: "optional",
    managed: true,
    u24: builtin("red-skills-herdr"),
    win: skip("herdr has no stable Windows build"),
  },
  {
    name: "just",
    about: "command runner; a Makefile without the Make",
    scope: "optional",
    u24: apt("just"),
    win: winget("Casey.Just"),
  },
  {
    name: "duf",
    about: "df you can read at a glance",
    scope: "optional",
    u24: apt("duf"),
    win: winget("muesli.duf"),
  },
  {
    name: "dust",
    about: "du sorted by what is actually large",
    scope: "optional",
    u24: mise("dust"),
    win: winget("bootandy.dust"),
  },
  {
    name: "hyperfine",
    about: "benchmark a command properly, with warmup and statistics",
    scope: "optional",
    u24: apt("hyperfine"),
    win: winget("sharkdp.hyperfine"),
  },
  {
    name: "glow",
    about: "render markdown in the terminal",
    scope: "optional",
    u24: mise("glow"),
    win: winget("charmbracelet.glow"),
  },
  {
    name: "gitui",
    about: "a lighter, keyboard-first alternative to lazygit",
    scope: "optional",
    u24: mise("gitui"),
    win: winget("StephanDilly.gitui"),
  },

  // ----------------------------------------------------------- wsl
  // Runs inside the distro but deliberately reaches the Windows host,
  // because under WSL the terminal, the fonts and the GUI all live
  // there. Without this scope the WSL target renders icon glyphs as
  // empty boxes and the "same experience" claim is simply false.
  {
    // First in the wsl scope: everything after it calls a .exe, and
    // without the binfmt entry every one of those fails with a message
    // that points nowhere near the cause.
    // Only where there are two environments to span. On bare-metal
    // Ubuntu there is no Windows side to share with, and on a server
    // there is no second anything — the provider says so rather than
    // creating a directory nothing will ever read.
    name: "shared-root",
    about: "one directory for configuration both environments read",
    scope: "core",
    managed: true,
    u24: builtin("shared-root"),
    win: builtin("shared-root"),
  },
  {
    // Core, not desktop or wsl, and that is not laziness.
    //
    // The Start Menu shortcuts have to be written from inside WSL, which
    // reaches the Windows host, and from native Windows, which is the
    // host — and no other scope covers both: wsl never applies on
    // Windows, desktop never applies inside a distro. Bare-metal Ubuntu
    // is the third target with a keyboard to claim, and its adapter
    // writes GNOME custom keybindings instead. The builtin picks the one
    // that belongs to this host and says so out loud on a machine with
    // neither, which is any server.
    name: "hotkeys",
    about: "the chord family, as Start Menu shortcuts and GNOME custom keybindings",
    scope: "core",
    managed: true,
    u24: builtin("hotkeys"),
    win: builtin("hotkeys"),
  },
  {
    // What checks a RedSkills package set's signature. The release signs
    // its manifest with cosign (keyless, through the GitHub Actions
    // identity), and red-dev verifies the bundle before `current` moves
    // — with the vendored Sigstore trust root, so an air-gapped depot
    // import verifies too. Spawned rather than reimplemented: a
    // signature verifier is the one component that must be the same
    // program the publisher's own verifier runs. src/red-skills-set.ts.
    name: "cosign",
    about: "verifies the RedSkills package set's release signature",
    scope: "core",
    u24: mise("cosign"),
    win: mise("cosign"),
  },
  {
    // The RedSkills core payload, which used to arrive as a curled
    // install.sh and therefore never moved again. It is an npm package,
    // so mise resolves it through the `npm:` backend and `red-dev
    // update` carries it forward with the rest of the suite.
    //
    // Deliberately not `github:`. That backend scores release assets to
    // put one executable on PATH; what is published here is a tree of
    // bundles and bin shims, which is what npm is for.
    //
    // Half a migration on its own: mise installs into its own tree and
    // every consumer on the machine resolves through
    // ~/.red/skills/current. src/red-skills-set.ts is the other half:
    // it copies this core and every plugin row below — at the one
    // version present in all of them — into a self-contained package
    // set under ~/.red/skills/sets and points current at it, straight
    // after any of these entries has run.
    //
    // Before the marketplace row below rather than after it: the row
    // below wires agents against the payload, and wiring against a
    // payload that is not there yet is the ordering bug that costs a
    // whole converge.
    name: "red-skills-core",
    about: "the RedSkills runtime bundles, resolved and kept current by mise",
    scope: "core",
    managed: true,
    u24: mise("npm:@reddb-io/red-skills", { alias: "red-skills" }),
    win: mise("npm:@reddb-io/red-skills", { alias: "red-skills" }),
  },
  // The plugins, one row each, and that is the point of them being here.
  //
  // They used to be a literal — ["dev", "memory", "brain"] — written out
  // in two loops in agents.ts, so every machine carried all three
  // whether or not anybody used them, and a fourth plugin was an edit in
  // two places that could disagree. A row is the opt-out this product
  // already has for everything else: delete it and nothing installs, no
  // entry is projected into the fragment, and the loops that reinstall
  // plugins after a marketplace repair have nothing to reinstall.
  //
  // In dependency order, which the loops preserve: memory declares dev.
  //
  // Rows rather than one row with a list, because a list would inherit
  // nothing. Each of these is a mise entry, so `mise upgrade` advances
  // it and `mise prune` reclaims the versions it leaves behind, which is
  // the whole argument for spending an entry per plugin. src/red-skills-
  // plugins.ts derives the set back out of this.
  {
    name: "red-skills-dev",
    about: "RedSkills dev plugin — engineering skills for coding agents",
    scope: "core",
    managed: true,
    u24: mise("npm:@reddb-io/red-skills-dev", { alias: "red-skills-dev" }),
    win: mise("npm:@reddb-io/red-skills-dev", { alias: "red-skills-dev" }),
  },
  {
    name: "red-skills-memory",
    about: "RedSkills memory plugin — governed operational memory, on top of dev",
    scope: "core",
    managed: true,
    u24: mise("npm:@reddb-io/red-skills-memory", { alias: "red-skills-memory" }),
    win: mise("npm:@reddb-io/red-skills-memory", { alias: "red-skills-memory" }),
  },
  {
    name: "red-skills-brain",
    about: "RedSkills brain plugin — a project-local knowledge repository",
    scope: "core",
    managed: true,
    u24: mise("npm:@reddb-io/red-skills-brain", { alias: "red-skills-brain" }),
    win: mise("npm:@reddb-io/red-skills-brain", { alias: "red-skills-brain" }),
  },
  {
    // After the agents, never before: the installer detects which CLIs
    // exist and wires each one, so running it on a machine with none
    // configures nothing and reports success. It sits at the end of
    // core for that reason.
    name: "red-skills",
    about: "the RedSkills marketplace, in whichever agents are installed",
    scope: "core",
    managed: true,
    u24: builtin("red-skills"),
    win: builtin("red-skills"),
  },
  {
    name: "codex-statusline",
    about: "project, branch, model, effort, context and quota windows in the Codex TUI",
    scope: "core",
    managed: true,
    u24: builtin("codex-statusline"),
    win: builtin("codex-statusline"),
  },
  {
    // Skipped silently when claude is not installed. Idempotent and
    // non-destructive: malformed JSON and explicit conflicting bindings
    // are never overwritten silently.
    name: "claude-keybindings",
    about: "Shift+Enter → newline in Claude Code Chat",
    scope: "core",
    managed: true,
    u24: builtin("claude-keybindings"),
    win: builtin("claude-keybindings"),
  },
  {
    // Core, like hotkeys and for the same reason: the three targets that
    // can display a Redwall are a desktop, a WSL distro whose images the
    // Windows host shows, and native Windows — and no other scope spans
    // all three. The builtin skips itself on a server, which is where
    // the scope is wider than the feature.
    //
    // Last in core, after the binary itself is in place: the declaration
    // names an absolute path to red-dev, and a hook declared before
    // there is anything at that path has the daemon exec nothing on
    // every Worker birth until the next converge.
    name: "redwall-hook",
    about: "keeps the Redwall current, through the RedSkills host hook",
    scope: "core",
    managed: true,
    u24: builtin("redwall-hook"),
    win: builtin("redwall-hook"),
  },
  {
    name: "wsl-interop",
    scope: "wsl",
    managed: true,
    u24: builtin("wsl-interop"),
    win: skip("native Windows needs no interop shim"),
  },
  {
    // WSL exports XDG_RUNTIME_DIR but never creates it, and the parent
    // is root-owned — so the programs that trust the variable get EACCES
    // rather than a fallback. zellij is the visible casualty.
    name: "wsl-runtime-dir",
    about: "XDG_RUNTIME_DIR that exists, so zellij can start",
    scope: "wsl",
    managed: true,
    u24: builtin("wsl-runtime-dir"),
    win: skip("native Windows has no XDG runtime dir"),
  },
  {
    name: "nerd-font",
    scope: "desktop",
    managed: true,
    u24: builtin("nerd-font"),
    win: builtin("nerd-font"),
  },
  {
    name: "nerd-font",
    scope: "wsl",
    managed: true,
    u24: builtin("nerd-font"),
    win: skip(HOST_PROVIDES),
  },
  {
    // The terminal that will run this distro lives on the host, so it
    // is installed there. winget.exe is reachable through interop —
    // which is exactly what upstream's PATH replacement was breaking.
    name: "alacritty-host",
    scope: "wsl",
    managed: true,
    u24: winget("Alacritty.Alacritty"),
    win: skip(HOST_PROVIDES),
  },
  {
    // The desktop scope, not the wsl one, and that is the whole point:
    // the wsl scope runs inside the distro and reaches out to Windows,
    // and native Windows never gets it. This is the crossing in the
    // other direction, so it belongs to the target that can make it.
    name: "wsl-sync",
    about: "the WSL distro, converged from the Windows side",
    scope: "desktop",
    managed: true,
    u24: skip("no distro to reach into from a Linux desktop"),
    win: builtin("wsl-sync"),
  },
  {
    name: "windows-terminal",
    scope: "wsl",
    managed: true,
    u24: builtin("windows-terminal"),
    win: skip(HOST_PROVIDES),
  },
];

/** Pick the provider column that applies to this machine. */
export function providerFor(tool: Tool, p: Platform): Provider {
  if (p.os === "darwin") {
    throw new RedError(
      "unsupported platform: darwin. macOS support is planned in Phase 5 as an adapter of the platform contracts; this is not a broken Ubuntu install.",
    );
  }

  // Docker is the one tool whose right answer depends on what the host
  // is already doing, not on which platform this is. Docker Desktop
  // shares one daemon with Windows and every integrated distro;
  // installing docker-ce here would add a second, and containers under
  // one are invisible to the other — with no error from either, which
  // is a genuinely confusing afternoon to lose.
  if (tool.name === "docker" && p.env === "wsl") {
    const { shouldInstallDockerHere } = requireDocker();
    const verdict = shouldInstallDockerHere(p);
    if (!verdict.install) return { kind: "skip", reason: verdict.reason };
  }

  if (p.os === "windows") return tool.win;
  if (versionAtLeast(p.version, "26.04")) return tool.u26 ?? tool.u24;
  return tool.u24;
}

/**
 * providerFor is synchronous and called from the plan loop, so the
 * docker check cannot be a dynamic import. Resolved lazily and cached
 * to keep the module graph acyclic.
 */
let dockerModule: typeof import("./docker.ts") | null = null;
function requireDocker(): typeof import("./docker.ts") {
  if (!dockerModule) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    dockerModule = require("./docker.ts") as typeof import("./docker.ts");
  }
  return dockerModule;
}

/**
 * Which scopes a plain converge touches. This is the whole matrix.
 *
 * `optional` is deliberately absent: it is reached through `red-dev
 * apps`, never by running install.
 */
export function applicableScopes(p: Platform): Scope[] {
  const scopes: Scope[] = ["core"];
  if (p.caps.gui) scopes.push("desktop");
  if (p.env === "wsl") scopes.push("wsl");
  return scopes;
}

/** Does this column need administrator rights to complete? */
export function needsAdmin(pr: Provider): boolean {
  return pr.needsAdmin === true;
}

/**
 * The items this target will ask administrator for, in manifest order.
 *
 * Answered from the declarations alone: nothing is executed, no
 * PowerShell is parsed and no Windows host is required, which is what
 * lets the question be settled before the converge starts rather than at
 * the item that needs the rights.
 *
 * Scoped to what a plain converge touches, so the answer describes what
 * is about to happen rather than everything the manifest could install.
 * On every Linux target the set is empty — sudo is a separate path that
 * already works, and this must not disturb it.
 *
 * `scopes` is what `plan core` and `install wsl` need: the caller has
 * already narrowed the run, and an answer taken from the full matrix
 * would name an item that run is never going to reach.
 */
export function itemsNeedingAdmin(p: Platform, scopes: Scope[] = applicableScopes(p)): Tool[] {
  return TOOLS.filter((t) => scopes.includes(t.scope) && needsAdmin(providerFor(t, p)));
}

/**
 * The four answers, kept apart so a report can tell them apart.
 *
 * "absent", "outdated" and "mismatched" all mean there is work to do,
 * but they fail differently and a converge that says "the binary is
 * absent" about a binary sitting on PATH sends whoever reads it looking
 * in the wrong place. "mismatched" is the one that can mean *too new* —
 * see Tool.pinVersion — and it is separate from "outdated" for that
 * reason alone: telling someone on 0.44.3 that they are behind 0.44.1
 * would be a lie, and the fix it implies is the opposite of the one
 * that works.
 */
export type InstallState = "ok" | "absent" | "outdated" | "mismatched";

export function installState(tool: Tool): InstallState {
  if (tool.managed) return "absent"; // the provider decides; see Tool.managed

  // Checked before the PATH probe rather than beside it: a tool that
  // declares a file has no command to find, so falling through would ask
  // the wrong question and answer "absent" on a machine that has it.
  if (tool.file) return existsSync(tool.file) ? "ok" : "absent";

  const candidates = tool.cmd ?? [tool.name];
  if (!candidates.some(present)) return "absent";
  // A name on PATH is not proof it is the right program — see Tool.signature.
  if (tool.signature && !identify(candidates, tool.signature)) return "absent";
  // Before the floor, and above it in the file for the same reason: a
  // pin is an exact answer, so a floor declared alongside one could only
  // ever agree with it or contradict it.
  if (tool.pinVersion && versionOtherThan(candidates, tool.pinVersion)) return "mismatched";
  if (tool.minVersion && versionBelow(candidates, tool.minVersion)) return "outdated";
  return "ok";
}

export function isInstalled(tool: Tool): boolean {
  return installState(tool) === "ok";
}

/**
 * On the machine at all, at whatever version.
 *
 * What removal cares about, and the reason it cannot reuse isInstalled:
 * once a version floor exists, "not installed" stops meaning "not
 * there". A tool below its floor would vanish from the uninstall list
 * while still sitting on disk — offering no way to remove the very thing
 * the doctor is complaining about.
 */
export function isPresent(tool: Tool): boolean {
  return installState(tool) !== "absent";
}

/**
 * The version this machine actually has, or null when it cannot be read.
 *
 * For reporting only. The decision is installState's; this exists so a
 * message can say which version is the problem instead of leaving the
 * reader to run --version themselves.
 */
export function installedVersion(tool: Tool): string | null {
  return probeVersion(tool.cmd ?? [tool.name]);
}

/**
 * What the first candidate on PATH says its version is, or null.
 *
 * Null covers two different disappointments — nothing on PATH, and
 * something on PATH whose output carries no version — and every caller
 * treats them the same way, by not claiming anything.
 */
function probeVersion(candidates: string[]): string | null {
  for (const c of candidates) {
    if (!commandExists(c)) continue;
    return parseVersion(versionOutput(c) ?? "");
  }
  return null;
}

/**
 * The first dotted numeric run in --version output: "NVIM v0.9.5" ->
 * "0.9.5".
 *
 * A `red.N` suffix becomes a fourth segment: "0.44.3+red.1" ->
 * "0.44.3.1". That is the reddb-io fork marker — cargo build metadata
 * on the binary (`+red.1`), a pre-release dash on the git tag
 * (`v0.44.3-red.1`, because a `+` cannot appear in a tag name). Both
 * spellings normalize to the same string so a pin, a tag and a
 * --version output stay comparable. Without the extra segment a fork
 * build and the stock release it patches are the same version, and the
 * doctor waves through exactly the binary the fork exists to replace.
 */
export function parseVersion(output: string): string | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?(?:[+-]red\.(\d+))?/.exec(output);
  if (!m) return null;
  const base = `${m[1]}.${m[2]}.${m[3] ?? "0"}`;
  return m[4] ? `${base}.${m[4]}` : base;
}

/** -1, 0 or 1, comparing segment by segment with missing segments as zero. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function versionBelow(candidates: string[], min: string): boolean {
  const found = probeVersion(candidates);
  // Unreadable output is not evidence of an old version, and treating
  // it as one would reinstall the tool on every single converge with
  // no run ever reaching a fixed point. Fail open and say nothing.
  return found === null ? false : compareVersions(found, min) < 0;
}

/** Anything but the pinned version, newer included. Fails open, as above. */
function versionOtherThan(candidates: string[], pin: string): boolean {
  const found = probeVersion(candidates);
  return found === null ? false : compareVersions(found, pin) !== 0;
}

/**
 * On PATH, or at a path.
 *
 * Not everything installed is a command. PowerToys puts PowerToys.exe in
 * %LOCALAPPDATA%\PowerToys and never touches PATH, so probing for the
 * name answered "missing" on a machine that had just installed it — the
 * same shape of wrong answer as the `red` collision, arrived at from the
 * opposite direction.
 *
 * A candidate containing a separator is a location; anything else is a
 * name. Environment variables in it are expanded, because the location
 * differs per user and hardcoding one profile helps nobody.
 */
function present(candidate: string): boolean {
  if (!/[\\/]/.test(candidate)) return commandExists(candidate);
  const expanded = candidate.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) =>
    process.env[name] ?? m,
  );
  return existsSync(expanded);
}

/**
 * Is the command on PATH actually the tool we mean?
 *
 * Runs it and matches its own output, because there is nothing else to
 * go on. Failure to run at all counts as "not ours": a program that
 * cannot answer `--version` is not one we can claim is installed.
 */
/**
 * Whatever `<cmd> --version` prints, both streams, or null if it will not run.
 *
 * stdin detached, and that is not defensive tidiness.
 *
 * The command being probed is by definition one whose name we do not
 * trust. /usr/bin/red is GNU ed, and an editor handed a terminal it can
 * read will sit on it forever — which is exactly what happened: the
 * converge stopped dead at step 13 with no child process and no output,
 * because the probe itself was waiting for someone to type.
 */
function versionOutput(cmd: string): string | null {
  try {
    const proc = Bun.spawnSync([cmd, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
  } catch {
    return null;
  }
}

function identify(candidates: string[], signature: RegExp): boolean {
  for (const c of candidates) {
    if (!commandExists(c)) continue;
    const out = versionOutput(c);
    if (out !== null && signature.test(out)) return true;
  }
  return false;
}

export function toolsInScope(scope: Scope): Tool[] {
  return TOOLS.filter((t) => t.scope === scope);
}

export function describeProvider(pr: Provider): string {
  switch (pr.kind) {
    case "apt":
      return `apt:${pr.pkg}`;
    case "winget":
      return `winget:${pr.id}`;
    case "installer":
      return `installer:${pr.url}`;
    case "gh":
      // The tag, when there is one, sits where the reader is already
      // looking for "which release": a plan that says only the repo
      // hides the whole point of a pinned column.
      return `gh:${pr.repo}${pr.version ? `@${pr.version}` : ""}:${pr.asset}`;
    case "mise": {
      // The alias, when there is one, is what the reader will type —
      // and it is routinely not the repository name. A plan line saying
      // only `mise:github:reddb-io/toon` hides that the command is `tq`.
      //
      // The version is named for the same reason the gh column names a
      // tag: `latest` is the case that needs no words, and a pin is the
      // whole point of the line it appears on. Omitting it would let a
      // plan describe a held-back zellij exactly like a floating one.
      const alias = pr.alias && pr.alias !== pr.spec ? ` (${pr.alias})` : "";
      const version = pr.version && pr.version !== "latest" ? `@${pr.version}` : "";
      return `mise:${pr.spec}${version}${alias}`;
    }
    case "ppa":
      return `ppa:${pr.ppa}`;
    case "aptrepo":
      return `aptrepo:${pr.pkgs.join(",")}`;
    case "builtin":
      return `builtin:${pr.name}`;
    case "skip":
      return `skip (${pr.reason})`;
  }
}
