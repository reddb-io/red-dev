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
  | "wsl";

export type Provider =
  | { kind: "apt"; pkg: string }
  | { kind: "winget"; id: string }
  /**
   * Resolve a release asset by *matching a glob against the names the
   * release actually has*, never by building a filename from a pinned
   * version. omakub-wsl pins gum to 0.14.1 but fetches from
   * /releases/latest/download/, so the path resolves to today's release
   * while the filename still says 0.14.1 — a guaranteed 404 the moment
   * upstream ships anything new. Matching real names fails loudly with
   * the available candidates instead.
   */
  | { kind: "gh"; repo: string; asset: string }
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
  | { kind: "builtin"; name: "nerd-font" | "windows-terminal" }
  /** Not installed here, deliberately. The reason is required. */
  | { kind: "skip"; reason: string };

export interface Tool {
  /** Stable logical name — what the user thinks they have. */
  name: string;
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
const gh = (repo: string, asset: string): Provider => ({ kind: "gh", repo, asset });
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
const builtin = (name: "nerd-font" | "windows-terminal"): Provider => ({
  kind: "builtin",
  name,
});
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
    name: "zellij",
    scope: "core",
    u24: gh("zellij-org/zellij", "zellij-x86_64-unknown-linux-musl.tar.gz"),
    // zellij has no native Windows build; on Windows the equivalent
    // panes/tabs come from Windows Terminal itself.
    win: skip("no native Windows build; Windows Terminal provides panes"),
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

  // ----------------------------------------------------------- wsl
  // Runs inside the distro but deliberately reaches the Windows host,
  // because under WSL the terminal, the fonts and the GUI all live
  // there. Without this scope the WSL target renders icon glyphs as
  // empty boxes and the "same experience" claim is simply false.
  {
    name: "nerd-font",
    scope: "wsl",
    managed: true,
    u24: builtin("nerd-font"),
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
  if (p.os === "windows") return tool.win;
  if (versionAtLeast(p.version, "26.04")) return tool.u26 ?? tool.u24;
  return tool.u24;
}

/** Which scopes apply here. This is the whole matrix, in four lines. */
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
