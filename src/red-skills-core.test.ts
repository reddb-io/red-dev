/**
 * The RedSkills core, as a mise entry and as the layout it lands in.
 *
 * These are two halves of one change and they are tested together for
 * the same reason they ship together: either alone leaves a machine
 * where RedSkills is installed and nothing can find it. The entry is
 * what makes the version move; the layout is what makes
 * ~/.red-skills/current name the version that moved.
 *
 * Everything below runs against a fabricated mise installs tree and a
 * temporary HOME, so it holds on a machine with no mise, no network and
 * no RedSkills. The one thing that cannot be faked here is Windows, and
 * the junction is pinned through the function that decides the link
 * flavour rather than by creating one — the decision is the part that
 * can regress, and getting it wrong is what would put the install
 * behind developer mode.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerFor, TOOLS } from "./manifest.ts";
import { miseEntries, miseToolNames, renderMiseConfig } from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import {
  convergeCoreAfterMise,
  convergeRedSkillsCoreLayout,
  corePayloadDir,
  directoryLinkType,
  installedCoreVersion,
  miseInstallDirName,
  redSkillsCurrentLink,
  redSkillsVersionDir,
  REDSKILLS_CORE_ALIAS,
  REDSKILLS_CORE_SPEC,
} from "./red-skills-core.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
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

const source = readFileSync(`${import.meta.dir}/red-skills-core.ts`, "utf8");

/**
 * A mise installs tree carrying the given versions.
 *
 * Shaped like the real one, including the selector links mise writes
 * beside the exact versions — `latest` and the truncated series — since
 * mistaking one of those for a version is the specific way version
 * discovery goes wrong.
 */
function fakeInstalls(versions: string[], opts: { selectors?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "red-core-installs-"));
  for (const version of versions) {
    const payload = corePayloadDir(dir, version);
    mkdirSync(join(payload, "bin"), { recursive: true });
    writeFileSync(
      join(payload, "package.json"),
      `${JSON.stringify({ name: "@reddb-io/red-skills", version })}\n`,
    );
    writeFileSync(join(payload, "bin", "red-skills-redskilled.mjs"), "");
  }
  if (opts.selectors !== false && versions.length > 0) {
    const newest = versions[versions.length - 1] as string;
    symlinkSync(`./${newest}`, join(dir, "latest"));
  }
  return dir;
}

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "red-core-home-"));
}

describe("the manifest entry mise resolves", () => {
  const row = TOOLS.find((t) => t.name === "red-skills-core");

  test("the core is in the manifest, on every target", () => {
    expect(row).toBeDefined();
    expect(row!.scope).toBe("core");
    for (const p of [UBUNTU, WINDOWS]) {
      expect(providerFor(row!, p)).toEqual({
        kind: "mise",
        spec: REDSKILLS_CORE_SPEC,
        alias: REDSKILLS_CORE_ALIAS,
      });
    }
  });

  test("it resolves through the npm backend, never through github", () => {
    // `github:` scores release assets to put one executable on PATH.
    // What is published here is a tree of bundles and bin shims, and
    // lifting one file out of it produces something that starts and
    // then cannot find the rest of itself.
    expect(REDSKILLS_CORE_SPEC.startsWith("npm:")).toBe(true);
  });

  test("the fragment projects it at latest, under the name people type", () => {
    for (const p of [UBUNTU, WINDOWS]) {
      const entry = miseEntries(p).find((e) => e.spec === REDSKILLS_CORE_SPEC);
      expect(entry, `${p.os}`).toEqual({
        spec: REDSKILLS_CORE_SPEC,
        alias: REDSKILLS_CORE_ALIAS,
        version: "latest",
      });
    }
  });

  test("the rendered fragment declares both halves, and quotes the spec", () => {
    // Unquoted, `npm:@reddb-io/red-skills = "latest"` is a TOML parse
    // error, and a parse error here disables every tool in the file.
    const out = renderMiseConfig(miseEntries(UBUNTU));
    expect(out).toContain('red-skills = "npm:@reddb-io/red-skills"');
    expect(out).toContain('red-skills = "latest"');
  });

  test("the projection is byte-identical across runs", () => {
    // The fragment is rewritten on every converge and compared against
    // disk to decide whether anything happened. A projection that
    // depends on manifest order or on object key order turns every
    // converge into a change and every change into a line claiming work
    // that was not done.
    const once = renderMiseConfig(miseEntries(UBUNTU));
    const twice = renderMiseConfig(miseEntries(UBUNTU));
    const reversed = renderMiseConfig([...miseEntries(UBUNTU)].reverse());
    expect(twice).toBe(once);
    expect(reversed).toBe(once);
  });

  test("`red-dev update` names it, so the version actually moves", () => {
    // Bare `mise upgrade` would reach the user's own runtimes too, so
    // the suite is upgraded by name — and a core missing from that list
    // is a core that is declared and never advanced.
    expect(miseToolNames(UBUNTU)).toContain(REDSKILLS_CORE_ALIAS);
  });

  test("the payload is declared before the row that wires agents to it", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.indexOf("red-skills-core")).toBeGreaterThan(-1);
    expect(names.indexOf("red-skills-core")).toBeLessThan(names.indexOf("red-skills"));
  });
});

describe("where mise puts it", () => {
  test("a tool named through [tool_alias] installs under the alias", () => {
    // Read off a real mise install rather than off its documentation:
    // an aliased tool does not get the flattened spec directory, it
    // gets the alias verbatim. The whole layout hangs on this string.
    expect(miseInstallDirName({ spec: REDSKILLS_CORE_SPEC, alias: REDSKILLS_CORE_ALIAS }))
      .toBe("red-skills");
  });

  test("a bare backend spec is flattened instead", () => {
    expect(miseInstallDirName({ spec: "npm:@types/semver" })).toBe("npm-types-semver");
    expect(miseInstallDirName({ spec: "npm:is-odd" })).toBe("npm-is-odd");
  });

  test("the newest exact version wins, compared as numbers", () => {
    // Lexically, 3.9.0 sorts after 3.10.0 — the ordering bug that only
    // shows up two years after it is written.
    expect(installedCoreVersion(fakeInstalls(["3.9.0", "3.10.0"]))).toBe("3.10.0");
  });

  test("mise's own selector links are not mistaken for versions", () => {
    // `latest` resolves to whichever version was asked for last. A
    // per-version directory pointed at a moving target is not one.
    const installs = fakeInstalls(["3.10.0"]);
    expect(existsSync(join(installs, "latest"))).toBe(true);
    expect(installedCoreVersion(installs)).toBe("3.10.0");
  });

  test("nothing installed is no opinion, not a failure", () => {
    expect(installedCoreVersion(join(tmpdir(), "red-core-absent-xyz"))).toBeNull();
  });
});

describe("the layout a converge lands in", () => {
  test("the per-version directory exists and current resolves to it", () => {
    const home = fakeHome();
    const installs = fakeInstalls(["3.18.12"]);

    const result = convergeRedSkillsCoreLayout({ home, installsDir: installs, platform: "linux" });

    expect(result).not.toBeNull();
    expect(result!.version).toBe("3.18.12");
    expect(result!.changed).toBe(true);

    const versions = redSkillsVersionDir(home, "3.18.12");
    const current = redSkillsCurrentLink(home);
    expect(versions).toBe(join(home, ".red-skills", "versions", "v3.18.12"));
    expect(existsSync(versions)).toBe(true);
    expect(realpathSync(current)).toBe(realpathSync(versions));
    // And the version directory names the package set mise installed,
    // rather than a copy of it.
    expect(realpathSync(versions)).toBe(realpathSync(corePayloadDir(installs, "3.18.12")));
  });

  test("a newer install moves current and leaves the older version in place", () => {
    const home = fakeHome();
    convergeRedSkillsCoreLayout({
      home,
      installsDir: fakeInstalls(["3.18.12"]),
      platform: "linux",
    });

    const upgraded = convergeRedSkillsCoreLayout({
      home,
      installsDir: fakeInstalls(["3.18.12", "3.19.0"]),
      platform: "linux",
    });

    expect(upgraded!.version).toBe("3.19.0");
    expect(existsSync(redSkillsVersionDir(home, "3.18.12"))).toBe(true);
    expect(realpathSync(redSkillsCurrentLink(home)))
      .toBe(realpathSync(redSkillsVersionDir(home, "3.19.0")));
  });

  test("mise having installed nothing leaves the machine alone", () => {
    const home = fakeHome();
    expect(
      convergeRedSkillsCoreLayout({
        home,
        installsDir: join(tmpdir(), "red-core-absent-xyz"),
        platform: "linux",
      }),
    ).toBeNull();
    expect(existsSync(join(home, ".red-skills"))).toBe(false);
  });

  test("a version directory the one-liner already wrote is used as it stands", () => {
    // Both install modes agree on the name of the per-version
    // directory, which is what lets them converge the same machine
    // without fighting over the tree: whoever gets there first owns its
    // contents, and the other has only the link left to move.
    const home = fakeHome();
    const installs = fakeInstalls(["3.18.12"]);
    const checkout = redSkillsVersionDir(home, "3.18.12");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    writeFileSync(join(checkout, "package.json"), "{}\n");

    const result = convergeRedSkillsCoreLayout({ home, installsDir: installs, platform: "linux" });

    expect(result!.changed).toBe(true);
    expect(lstatSync(checkout).isSymbolicLink()).toBe(false);
    expect(existsSync(join(checkout, "scripts"))).toBe(true);
    expect(realpathSync(redSkillsCurrentLink(home))).toBe(realpathSync(checkout));
  });

  test("the layout step ignores every tool that is not the core", () => {
    const home = fakeHome();
    expect(
      convergeCoreAfterMise("github:reddb-io/reddb", {
        home,
        installsDir: fakeInstalls(["3.18.12"]),
        platform: "linux",
      }),
    ).toBeNull();
    expect(existsSync(join(home, ".red-skills"))).toBe(false);
  });
});

describe("a converge that has nothing to do", () => {
  test("is a no-op when current already names the resolved version", () => {
    const home = fakeHome();
    const installs = fakeInstalls(["3.18.12"]);
    convergeRedSkillsCoreLayout({ home, installsDir: installs, platform: "linux" });

    const current = redSkillsCurrentLink(home);
    const before = lstatSync(current).ino;

    const again = convergeRedSkillsCoreLayout({ home, installsDir: installs, platform: "linux" });

    expect(again!.changed).toBe(false);
    expect(again!.version).toBe("3.18.12");
    // Recreating the link would mint a new inode. Everything downstream
    // stats this one path, so a converge that rewrites it on every run
    // is a converge that reports work it did not do.
    expect(lstatSync(current).ino).toBe(before);
  });
});

describe("the Windows link", () => {
  test("is a junction, which needs no developer mode", () => {
    // A "dir" symlink on Windows needs SeCreateSymbolicLinkPrivilege,
    // which an ordinary account only holds with developer mode on — a
    // machine-wide setting an installer has no business demanding. A
    // junction is an ordinary directory reparse point any user can
    // create, so the install is not gated on anything.
    expect(directoryLinkType("win32")).toBe("junction");
  });

  test("every other platform gets a plain directory symlink", () => {
    expect(directoryLinkType("linux")).toBe("dir");
    expect(directoryLinkType("darwin")).toBe("dir");
  });

  test("the link is created with that flavour, and never as a copy", () => {
    // The directory-copy path is the class of bug
    // repairCopiedRedSkillsCurrent exists to clean up after: a copied
    // `current` is a snapshot that stops tracking the version it was
    // taken from, and reports success forever.
    expect(source).toContain("symlinkSync(target, path, directoryLinkType(platform))");
    expect(source).not.toContain("cpSync(");
    expect(source).not.toContain("copyFileSync(");
  });

  test("a real directory in the way is left alone rather than deleted", () => {
    // Git Bash emulates a symlink as a copy, so `current` can be a real
    // tree. Removing it here would be this module deleting data it did
    // not create.
    const home = fakeHome();
    const current = redSkillsCurrentLink(home);
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "mine.txt"), "keep");

    expect(
      convergeRedSkillsCoreLayout({
        home,
        installsDir: fakeInstalls(["3.18.12"]),
        platform: "linux",
      }),
    ).toBeNull();
    expect(existsSync(join(current, "mine.txt"))).toBe(true);
  });
});

describe("the consumers that resolve through current", () => {
  /** Run `fn` with HOME and USERPROFILE pointed at a fabricated machine. */
  async function withHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
    const savedHome = process.env["HOME"];
    const savedProfile = process.env["USERPROFILE"];
    process.env["HOME"] = home;
    delete process.env["USERPROFILE"];
    try {
      return await fn();
    } finally {
      if (savedHome === undefined) delete process.env["HOME"];
      else process.env["HOME"] = savedHome;
      if (savedProfile !== undefined) process.env["USERPROFILE"] = savedProfile;
    }
  }

  test("the extension builder still finds the source, and resolves past the link", async () => {
    const home = fakeHome();
    const installs = fakeInstalls(["3.18.12"]);
    convergeRedSkillsCoreLayout({ home, installsDir: installs, platform: "linux" });

    const { resolvedSource, sourceRoot } = await import("./red-skills-ext.ts");
    await withHome(home, () => {
      expect(sourceRoot()).toBe(`${home}/.red-skills/current`);
      // The link is the only thing that moves and every version under
      // it is immutable, so the resolved path is the whole freshness
      // question for anything built out of the tree.
      expect(resolvedSource()).toBe(realpathSync(corePayloadDir(installs, "3.18.12")));
    });
  });

  test("the host census still finds the resident client", async () => {
    const home = fakeHome();
    const installs = fakeInstalls(["3.18.12"]);
    convergeRedSkillsCoreLayout({ home, installsDir: installs, platform: "linux" });

    const { resolveRedskilledBin } = await import("./host-state.ts");
    expect(resolveRedskilledBin(home)).toBe(
      `${home}/.red-skills/current/bin/red-skills-redskilled.mjs`,
    );
  });

  test("a source checkout still wins where it exists", async () => {
    // The checkout path is checked first on purpose: a machine with
    // both should prefer the tree it can also build the extension from.
    const home = fakeHome();
    const checkout = redSkillsVersionDir(home, "3.18.12");
    mkdirSync(join(checkout, "packaging", "npm", "bin"), { recursive: true });
    writeFileSync(join(checkout, "packaging", "npm", "bin", "red-skills-redskilled.mjs"), "");
    convergeRedSkillsCoreLayout({
      home,
      installsDir: fakeInstalls(["3.18.12"]),
      platform: "linux",
    });

    const { resolveRedskilledBin } = await import("./host-state.ts");
    expect(resolveRedskilledBin(home)).toBe(
      `${home}/.red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs`,
    );
  });

  test("the WSL rescue shim looks in both places too", () => {
    // It runs inside a distro from native Windows and has no red-dev to
    // ask, so the two candidate paths are written into the program
    // itself. One of them missing is a distro that reports no host.
    const hostState = readFileSync(`${import.meta.dir}/host-state.ts`, "utf8");
    expect(hostState).toContain(
      '.red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs',
    );
    expect(hostState).toContain('.red-skills/current/bin/red-skills-redskilled.mjs');
  });
});

describe("the converge path that runs the layout step", () => {
  const providers = readFileSync(`${import.meta.dir}/providers.ts`, "utf8");

  test("a mise install is followed by the link, or the core is installed and invisible", () => {
    expect(providers).toContain("convergeCoreAfterMise(pr.spec)");
  });

  test("the suite install and the suite upgrade reach it as well", () => {
    // `install core` runs the whole fragment in one pass and `update`
    // upgrades it in one pass; neither goes through the per-tool
    // provider above, so neither would move the link on its own.
    const suite = providers.slice(providers.indexOf("export async function miseInstallSuite"));
    expect(suite.slice(0, suite.indexOf("\n}"))).toContain("linkRedSkillsCore()");
    const upgrade = providers.slice(providers.indexOf("export async function miseUpgradeSuite"));
    expect(upgrade.slice(0, upgrade.indexOf("\n}"))).toContain("linkRedSkillsCore()");
  });
});
