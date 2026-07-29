import { describe, expect, test } from "bun:test";
import { globToRegExp } from "./providers.ts";

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
