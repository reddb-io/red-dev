import { describe, expect, test } from "bun:test";

import { providerFor, TOOLS } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { declaredAptPackages, declaredWingetIds, globToRegExp } from "./providers.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const WINDOWS: Platform = {
  ...UBUNTU,
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

describe("globToRegExp", () => {
  test("matches the exact asset name", () => {
    const re = globToRegExp("zellij-x86_64-unknown-linux-musl.tar.gz");
    expect(re.test("zellij-x86_64-unknown-linux-musl.tar.gz")).toBe(true);
  });

  test("a dot is literal, not any-character", () => {
    // Without escaping, "atuin.tar.gz" would match "atuinXtar.gz" and
    // we would happily download the wrong file.
    const re = globToRegExp("atuin.tar.gz");
    expect(re.test("atuinXtarYgz")).toBe(false);
  });

  test("* spans a version segment", () => {
    const re = globToRegExp("carapace-bin_*_linux_amd64.deb");
    expect(re.test("carapace-bin_1.7.3_linux_amd64.deb")).toBe(true);
    expect(re.test("carapace-bin_2.0.0_linux_amd64.deb")).toBe(true);
  });

  test("is anchored, so a longer name does not match", () => {
    // The bug this guards: matching a substring would pick
    // lazygit_..._Linux_x86_64.tar.gz.sha256 over the archive itself.
    const re = globToRegExp("lazygit_*_Linux_x86_64.tar.gz");
    expect(re.test("lazygit_0.44.1_Linux_x86_64.tar.gz")).toBe(true);
    expect(re.test("lazygit_0.44.1_Linux_x86_64.tar.gz.sha256")).toBe(false);
    expect(re.test("prefix-lazygit_0.44.1_Linux_x86_64.tar.gz")).toBe(false);
  });

  test("does not confuse architectures", () => {
    const re = globToRegExp("nvim-linux-x86_64.tar.gz");
    expect(re.test("nvim-linux-arm64.tar.gz")).toBe(false);
  });

  test("a version pinned into the glob still has to exist upstream", () => {
    // omakub-wsl pins gum 0.14.1 but fetches from /latest/download/, so
    // the path tracks the newest release while the filename does not.
    // Matching against real asset names turns that into a loud failure
    // instead of a 404.
    const re = globToRegExp("gum_0.14.1_amd64.deb");
    expect(re.test("gum_0.16.0_amd64.deb")).toBe(false);
  });
});

describe("what `red-dev update` moves", () => {
  test("only the packages the manifest declares, on both package managers", () => {
    // The report that started this: someone ran `red-dev update` to get
    // a newer ripgrep and found Audacity upgraded. `winget upgrade
    // --all` and `apt full-upgrade` are "update this computer", which is
    // not what a tool managing a named list is entitled to do.
    const apt = declaredAptPackages(UBUNTU);
    expect(apt.length).toBeGreaterThan(0);
    expect(apt).toContain("git");
    expect(apt).toEqual([...apt].sort());
    // Nothing here is a package red-dev does not declare.
    for (const pkg of apt) {
      expect(TOOLS.some((t) => JSON.stringify(providerFor(t, UBUNTU)).includes(pkg))).toBe(true);
    }

    const winget = declaredWingetIds(WINDOWS);
    expect(winget.length).toBeGreaterThan(0);
    expect(winget).toContain("Git.Git");
    expect(winget).toEqual([...winget].sort());
  });

  test("the apt list covers repository and PPA packages too, not only plain apt", () => {
    const apt = declaredAptPackages(UBUNTU);
    // aptrepo (docker) and ppa (neovim) declare `pkgs`, not `pkg`; an
    // enumeration that only knew about `apt` would upgrade neither.
    expect(apt).toContain("docker-ce");
    expect(apt).toContain("neovim");
  });

  test("each side names only its own package manager's packages", () => {
    // Windows has no apt list at all; the winget list is what the
    // Windows converge would install, so it is what an update may move.
    expect(declaredAptPackages(WINDOWS)).toEqual([]);
    expect(declaredWingetIds(WINDOWS)).toContain("BurntSushi.ripgrep.MSVC");
  });
});
