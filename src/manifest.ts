/**
 * The single place where "what to install" lives.
 *
 * This is data, but typed data: a malformed provider is a compile error
 * rather than a runtime surprise. That matters more than it sounds —
 * the bug that motivated this project was a provider URL that was wrong
 * for months without anything failing loudly.
 */

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

export type Provider =
  | { kind: "apt"; pkg: string }
  | { kind: "winget"; id: string }
  /**
   * A global npm package. Used where the same package serves every
   * target: one name, one version, no per-platform skew. The agent CLIs
   * all exist in winget too, and all lag npm by a release or two, which
   * would put a different version on Windows than on Linux for no gain.
   *
   * These live in the mise-managed node prefix, so a node major bump
   * loses them — re-running install puts them back, which is the same
   * contract every other provider here has.
   */
  /**
   * The vendor's own install script, fetched and run.
   *
   * Used for tools whose publisher treats this as the supported path.
   * It is `curl | sh` from a third party, which is a real trust
   * decision, so it is spelled out in the manifest rather than hidden
   * inside a helper: the URL is visible at the point of use.
   *
   * Preferred over npm for these, because npm 11 gates postinstall
   * scripts by default and several of them fetch the platform binary in
   * exactly that hook — which installs cleanly and leaves a command that
   * does not work.
   */
  | { kind: "installer"; url: string; note: string }
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
       * Install name, when the release publishes a bare binary whose
       * asset name is not the command. tealdeer ships
       * `tealdeer-linux-x86_64-musl` and the command is `tldr`.
       */
      bin?: string;
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
        | "blesh"
        | "runtimes";
    }
  /** Not installed here, deliberately. The reason is required. */
  | { kind: "skip"; reason: string };

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
const installer =(url: string, note: string): Provider => ({
  kind: "installer",
  url,
  note,
});
const gh = (repo: string, asset: string, bin?: string): Provider => ({
  kind: "gh",
  repo,
  asset,
  ...(bin ? { bin } : {}),
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
    | "blesh"
    | "runtimes",
): Provider => ({ kind: "builtin", name });
const skip = (reason: string): Provider => ({ kind: "skip", reason });

const NO_GUI = "no GUI layer on this target";
const HOST_PROVIDES = "the Windows host provides this instead";

export const TOOLS: Tool[] = [
  // ---------------------------------------------------------- core
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
  { name: "zoxide", scope: "core", u24: apt("zoxide"), win: winget("ajeetdsouza.zoxide") },
  { name: "fzf", scope: "core", u24: apt("fzf"), win: winget("junegunn.fzf") },
  { name: "btop", scope: "core", u24: apt("btop"), win: winget("aristocratos.btop4win") },
  { name: "jq", scope: "core", u24: apt("jq"), win: winget("jqlang.jq") },

  // The bash answer to what people actually want from oh-my-zsh.
  // Every one of these is cross-shell and cross-platform, which is why
  // they belong in core rather than in a Linux-only corner.
  {
    name: "starship",
    scope: "core",
    u24: gh("starship/starship", "starship-x86_64-unknown-linux-gnu.tar.gz"),
    win: winget("Starship.Starship"),
  },
  {
    name: "atuin",
    scope: "core",
    u24: gh("atuinsh/atuin", "atuin-x86_64-unknown-linux-musl.tar.gz"),
    win: winget("Atuinsh.Atuin"),
  },
  {
    name: "carapace",
    scope: "core",
    u24: gh("carapace-sh/carapace-bin", "carapace-bin_*_linux_amd64.deb"),
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
    u24: gh("sxyazi/yazi", "yazi-x86_64-unknown-linux-gnu.zip"),
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
    u24: gh("jesseduffield/lazygit", "lazygit_*_Linux_x86_64.tar.gz"),
    win: winget("JesseDuffield.lazygit"),
  },
  {
    name: "lazydocker",
    scope: "core",
    u24: gh("jesseduffield/lazydocker", "lazydocker_*_Linux_x86_64.tar.gz"),
    win: winget("JesseDuffield.lazydocker"),
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
    name: "zellij",
    scope: "core",
    u24: gh("zellij-org/zellij", "zellij-x86_64-unknown-linux-musl.tar.gz"),
    win: winget("Zellij.Zellij"),
  },
  {
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
    name: "neovim",
    cmd: ["nvim"],
    scope: "core",
    // The archive ships 0.9.5 on noble. LazyVim runs on it but the
    // ecosystem has moved on, and the upstream tarball is not a drop-in
    // either: nvim needs its runtime tree, so installing just the
    // binary produces a broken editor. The PPA packages both properly.
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
  // Coding agents. Same package, same version, all five targets — which
  // is the point: an agent that behaves differently depending on which
  // machine you opened is worse than not having it there.
  //
  // Ordered after `runtimes` because they install into the node prefix
  // mise provides; without that step there is no npm to install with.
  {
    name: "claude-code",
    cmd: ["claude"],
    scope: "core",
    u24: installer("https://claude.ai/install.sh", "Anthropic's official installer"),
    win: winget("Anthropic.ClaudeCode"),
  },
  {
    name: "opencode",
    scope: "core",
    u24: installer("https://opencode.ai/install", "opencode's official installer"),
    win: winget("SST.opencode"),
  },
  {
    // No install script published; the release carries a static musl
    // binary, which is the most portable of the three.
    name: "codex",
    scope: "core",
    u24: gh("openai/codex", "codex-x86_64-unknown-linux-musl.tar.gz"),
    win: winget("OpenAI.Codex"),
  },
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
    // Installed but not enabled: see the note in src/blesh.ts. Turning
    // it on is RED_BLE=1, and the reason it is not the default is that
    // it replaces the line editor atuin, fzf and carapace bind into.
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

  // ------------------------------------------------------ optional
  // Chosen, never assumed. `red-dev apps` offers these; a plain
  // converge ignores them entirely.
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
    u24: gh("bootandy/dust", "dust-*-x86_64-unknown-linux-musl.tar.gz"),
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
    u24: gh("charmbracelet/glow", "glow_*_Linux_x86_64.tar.gz"),
    win: winget("charmbracelet.glow"),
  },
  {
    name: "gitui",
    about: "a lighter, keyboard-first alternative to lazygit",
    scope: "optional",
    u24: gh("gitui-org/gitui", "gitui-linux-x86_64.tar.gz"),
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
    name: "wsl-interop",
    scope: "wsl",
    managed: true,
    u24: builtin("wsl-interop"),
    win: skip("native Windows needs no interop shim"),
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
    name: "windows-terminal",
    scope: "wsl",
    managed: true,
    u24: builtin("windows-terminal"),
    win: skip(HOST_PROVIDES),
  },
];

/** Pick the provider column that applies to this machine. */
export function providerFor(tool: Tool, p: Platform): Provider {
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

export function isInstalled(tool: Tool): boolean {
  if (tool.managed) return false; // the provider decides; see Tool.managed
  const candidates = tool.cmd ?? [tool.name];
  return candidates.some(commandExists);
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
      return `gh:${pr.repo}:${pr.asset}`;
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
