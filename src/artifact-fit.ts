/**
 * Which machine an artifact was built for, read off its own name.
 *
 * A lock already refuses a moving version, an unofficial origin and a
 * checksum nobody computed. This is the third way one entry can be wrong
 * while looking right: the version is exact, the URL is the publisher's,
 * and the file behind it was compiled for somebody else's machine. On a
 * connected workstation that mistake surfaces as a failed `dpkg` and a
 * second try; on an offline target it surfaces after the medium has been
 * unplugged, which is the wrong end of the journey to discover it.
 *
 * The only evidence available here is the artifact name, because that is
 * what a lock carries beside the URL — and it is better evidence than it
 * looks, since every publisher in the catalogue puts the machine in the
 * file name: Debian's `name_version_arch.deb`, GitHub's
 * `tool-version-os-arch.tar.gz`, Microsoft's `Setup-x64.exe`.
 *
 * So the rule is deliberately one-sided. A name that declares a machine
 * is held to it; a name that declares nothing — `codex-0.55.0.tgz`, a
 * platform-independent npm tarball — fits everywhere, because silence is
 * not a claim and refusing it would refuse half the catalogue. What this
 * catches is the artifact that says, in the publisher's own convention,
 * that it belongs somewhere else.
 *
 * ## Why the series rule is narrow
 *
 * "24" and "26" appear in versions all over a workstation — Node 24,
 * mise 2026.8.3 — so an Ubuntu series is only read when the name pins
 * it the way a Debian revision does: a release codename, or a `~`, `+`
 * or `ubuntu` immediately before it. A rule loose enough to see `24.04`
 * anywhere would refuse Node 24 on Ubuntu 26, which is the false refusal
 * that would teach people to switch the check off.
 */

import type { LockSurface } from "./workstation-lock.ts";

/** The Ubuntu releases this project targets, by codename. PURE data. */
export const UBUNTU_SERIES: Record<string, string> = {
  noble: "24.04",
  resolute: "26.04",
};

/** The distro families a packaging format belongs to. */
export type PackageFamily = "debian" | "redhat";

/** What one artifact name says about the machine it was built for. */
export interface ArtifactBuild {
  /** The operating system the name declares, or null when it declares none. */
  os: "linux" | "windows" | "darwin" | null;
  /** The architecture the name declares, in the vocabulary a surface uses. */
  arch: "x64" | "arm64" | null;
  /** An Ubuntu release the name pins itself to, as `"24.04"`. */
  series: string | null;
  /** A packaging format only one distro family installs. */
  family: PackageFamily | null;
}

/** A token surrounded by the separators publishers actually use. PURE. */
function token(body: string): RegExp {
  return new RegExp(String.raw`(?:^|[-_.~+])(?:${body})(?=[-_.~+]|$)`, "i");
}

const WINDOWS = token("windows|win32|win64|win");
const DARWIN = token("darwin|macos|osx|apple");
const LINUX = token("linux");
const ARM64 = token("arm64|aarch64");
const X64 = token("x64|x86_64|amd64");

/** The extensions that name an operating system on their own. */
const BY_EXTENSION: [RegExp, "linux" | "windows" | "darwin"][] = [
  [/\.(?:exe|msi)$/i, "windows"],
  [/\.(?:dmg|pkg)$/i, "darwin"],
  [/\.(?:deb|rpm|appimage)$/i, "linux"],
];

/** A Debian revision suffix pinning a release: `~noble`, `~ubuntu24.04`, `+26.04`. */
const SERIES_SUFFIX = /(?:^|[-_~+])(?:ubuntu[-_]?)?(\d{2}\.04)(?=[-_.~+]|$)/i;

/**
 * Read one artifact name for the machine it declares. PURE.
 *
 * Every field is independently absent: an artifact can say it is a Linux
 * build without saying which architecture, and a `.deb` says its family
 * and its operating system while saying nothing about the release. Null
 * everywhere means the name made no claim at all, which is a perfectly
 * ordinary thing for an npm tarball to do.
 */
export function artifactBuild(name: string): ArtifactBuild {
  let os: ArtifactBuild["os"] = null;
  if (WINDOWS.test(name)) os = "windows";
  else if (DARWIN.test(name)) os = "darwin";
  else if (LINUX.test(name)) os = "linux";
  if (os === null) {
    for (const [pattern, declared] of BY_EXTENSION) {
      if (pattern.test(name)) {
        os = declared;
        break;
      }
    }
  }

  // arm64 first: `aarch64` and `x86_64` never co-occur, but a name that
  // somehow carried both is more likely to be the narrower build.
  const arch: ArtifactBuild["arch"] = ARM64.test(name) ? "arm64" : X64.test(name) ? "x64" : null;

  let series: string | null = null;
  for (const [codename, release] of Object.entries(UBUNTU_SERIES)) {
    if (token(codename).test(name)) {
      series = release;
      break;
    }
  }
  if (series === null) {
    const suffix = SERIES_SUFFIX.exec(name);
    // `~24.04` and `~ubuntu24.04` pin a release; `2026.8.3` does not,
    // and the leading separator is the whole of the difference.
    if (suffix?.[1] !== undefined) series = suffix[1];
  }

  const family: PackageFamily | null = /\.deb$/i.test(name)
    ? "debian"
    : /\.rpm$/i.test(name)
      ? "redhat"
      : null;

  return { os, arch, series, family };
}

/** The distros that install one packaging format. */
const FAMILY_DISTROS: Record<PackageFamily, string[]> = {
  debian: ["ubuntu", "debian"],
  redhat: ["fedora", "rhel", "centos", "rocky", "almalinux"],
};

/**
 * Why this artifact does not belong on this surface, or null. PURE.
 *
 * One sentence, naming the artifact, because the caller folds it into a
 * lock audit line that already names the application and the surface —
 * and an operator reading "herdr on ubuntu-26.04-x64: artifact
 * herdr_0.9.4~noble_amd64.deb is built for Ubuntu 24.04, not 26.04" has
 * the whole of the problem without opening anything.
 */
export function artifactFit(surface: LockSurface, name: string): string | null {
  const build = artifactBuild(name);
  const said = (what: string) => `artifact ${name} is built for ${what}`;

  if (build.os !== null && build.os !== surface.os) {
    return `${said(build.os)}, not ${surface.os}`;
  }
  if (build.arch !== null && build.arch !== surface.arch) {
    return `${said(build.arch)}, not ${surface.arch}`;
  }
  if (build.family !== null && !FAMILY_DISTROS[build.family].includes(surface.distro)) {
    return `artifact ${name} is a ${build.family} package, which ${surface.distro} does not install`;
  }
  // Only Ubuntu surfaces have an Ubuntu release to disagree with: a
  // `~noble` build on a Debian surface is somebody else's problem, and
  // guessing at it here would be inventing a rule nobody wrote down.
  if (build.series !== null && surface.distro === "ubuntu" && build.series !== surface.version) {
    return `${said(`Ubuntu ${build.series}`)}, not ${surface.version}`;
  }
  return null;
}
