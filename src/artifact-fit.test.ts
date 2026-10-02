/**
 * Which machine an artifact was built for, and where it may not go.
 *
 * The lock already refuses a moving version and an unofficial origin.
 * This is the third way a lock can be wrong about an application: the
 * version is exact, the URL is the publisher's own, and the file behind
 * it was built for somebody else's machine. A target that installed it
 * would fail at `dpkg` rather than at resolution, which on an offline
 * machine is the wrong end of the journey to find out.
 */

import { describe, expect, test } from "bun:test";

import { artifactBuild, artifactFit, UBUNTU_SERIES } from "./artifact-fit.ts";
import type { LockSurface } from "./workstation-lock.ts";

const ubuntu = (version: string): LockSurface => ({
  id: `ubuntu-${version}-x64`,
  os: "linux",
  distro: "ubuntu",
  version,
  arch: "x64",
  env: "desktop",
  role: "both",
});

const windows: LockSurface = {
  id: "windows-11-x64",
  os: "windows",
  distro: "windows",
  version: "11",
  arch: "x64",
  env: "windows",
  role: "gui",
};

describe("reading what an artifact name declares", () => {
  test("a publisher's own asset names say the machine they were built for", () => {
    expect(artifactBuild("red-dev-windows-x64.exe")).toEqual({
      os: "windows",
      arch: "x64",
      series: null,
      family: null,
    });
    expect(artifactBuild("zellij-x86_64-unknown-linux-musl.tar.gz")).toEqual({
      os: "linux",
      arch: "x64",
      series: null,
      family: null,
    });
    expect(artifactBuild("code_1.104.2-1_amd64.deb")).toEqual({
      os: "linux",
      arch: "x64",
      series: null,
      family: "debian",
    });
  });

  test("an artifact that declares nothing is not a claim that it fits everywhere", () => {
    expect(artifactBuild("codex-0.55.0.tgz")).toEqual({
      os: null,
      arch: null,
      series: null,
      family: null,
    });
  });

  test("a Debian series reaches the name through a codename or a suffix", () => {
    expect(artifactBuild("herdr_0.9.4~noble_amd64.deb").series).toBe("24.04");
    expect(artifactBuild("herdr_0.9.4~resolute_amd64.deb").series).toBe("26.04");
    expect(artifactBuild("herdr_0.9.4~ubuntu24.04_amd64.deb").series).toBe("24.04");
    expect(artifactBuild("herdr_0.9.4+26.04_amd64.deb").series).toBe("26.04");
    expect(UBUNTU_SERIES["noble"]).toBe("24.04");
    expect(UBUNTU_SERIES["resolute"]).toBe("26.04");
  });

  test("a version that happens to contain digits is not a series", () => {
    // The trap this exists for: "24" and "26" appear in half the
    // versions a workstation locks, and a rule that read them as an
    // Ubuntu release would refuse Node 24 on Ubuntu 26.
    expect(artifactBuild("node-v24.7.0-linux-x64.tar.xz").series).toBeNull();
    expect(artifactBuild("mise_2026.8.3_amd64.deb").series).toBeNull();
    expect(artifactBuild("Python-3.13.5.tar.xz").series).toBeNull();
  });
});

describe("whether one artifact fits one surface", () => {
  test("an artifact that declares nothing fits, because nothing said otherwise", () => {
    expect(artifactFit(ubuntu("26.04"), "codex-0.55.0.tgz")).toBeNull();
    expect(artifactFit(ubuntu("26.04"), "code_1.104.2-1_amd64.deb")).toBeNull();
  });

  test("an Ubuntu 26 surface refuses an artifact built for Ubuntu 24", () => {
    const reason = artifactFit(ubuntu("26.04"), "herdr_0.9.4~noble_amd64.deb");
    expect(reason).toBe("artifact herdr_0.9.4~noble_amd64.deb is built for Ubuntu 24.04, not 26.04");
    // And the same artifact on the machine it was built for is fine.
    expect(artifactFit(ubuntu("24.04"), "herdr_0.9.4~noble_amd64.deb")).toBeNull();
  });

  test("an Ubuntu surface refuses an artifact built for another operating system", () => {
    expect(artifactFit(ubuntu("26.04"), "red-dev-windows-x64.exe")).toBe(
      "artifact red-dev-windows-x64.exe is built for windows, not linux",
    );
    expect(artifactFit(ubuntu("26.04"), "mise-2026.8.3-macos-x64.tar.gz")).toBe(
      "artifact mise-2026.8.3-macos-x64.tar.gz is built for darwin, not linux",
    );
    expect(artifactFit(windows, "code_1.104.2-1_amd64.deb")).toBe(
      "artifact code_1.104.2-1_amd64.deb is built for linux, not windows",
    );
  });

  test("an x64 surface refuses an artifact built for another architecture", () => {
    expect(artifactFit(ubuntu("26.04"), "node-v24.7.0-linux-arm64.tar.xz")).toBe(
      "artifact node-v24.7.0-linux-arm64.tar.xz is built for arm64, not x64",
    );
  });

  test("a packaging format only one distro family installs is refused by the others", () => {
    expect(artifactFit(ubuntu("26.04"), "code-1.104.2.el9.x86_64.rpm")).toBe(
      "artifact code-1.104.2.el9.x86_64.rpm is a redhat package, which ubuntu does not install",
    );
  });
});
