/**
 * Acquisition: what is resolved, what is downloaded once, and what is
 * refused before anything on this machine moves.
 *
 * Two halves, tested from two directions. The resolution is pure — a
 * selector and a listing in, one commit out — so it is asserted
 * directly, including the orderings semver gets wrong when it is
 * written by hand. Everything else runs against a fake `git` that
 * records the argv it was given and materialises the trees a real one
 * would, because the properties worth having are properties of the
 * *sequence*: one clone for two versions, one snapshot per commit, no
 * work at all for a revision the machine already has, and no host
 * reconciliation until the identity actually moved.
 *
 * One test runs against the real git binary over a repository it builds
 * in a temp directory. The fake proves the sequence; that one proves
 * the sequence is issued to something that answers the way the fake
 * says it does — `git archive` into `tar -x` producing a tree with no
 * `.git` in it, from a mirror cloned once.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { captureTo } from "./log.ts";
import {
  acquireRedSkills,
  announce,
  compareVersions,
  directoryAssetProvider,
  ensureMirror,
  ensureSnapshot,
  extractArgv,
  githubAssetProvider,
  listRemoteRevisions,
  lsRemoteArgv,
  mirrorCloneArgv,
  overlaysIntoTree,
  parseRemoteRevisions,
  parseSelector,
  parseSymlinkEntries,
  reconcileRedSkills,
  reconciledStampPath,
  redSkillsCandidateDir,
  redSkillsMirrorDir,
  redSkillsSnapshotDir,
  resolveRevision,
  selectorLabel,
  type Acquisition,
  type AcquireOptions,
  type AssetProvider,
  type CommandRunner,
  type Reconciliation,
  type ReconcileOptions,
  type RemoteRevision,
} from "./red-skills-acquire.ts";
import { runPluginPhase } from "./red-skills-mise-plugin.ts";
import { runStagedUpdate } from "./staged-update.ts";
import {
  createPackageSetManifest,
  encodePackageSet,
  activateStagedPackageSet,
  readPackageSetState,
  redSkillsCurrentLink,
  SET_BUNDLE_NAME,
  SET_MANIFEST_NAME,
  type SignatureVerifier,
} from "./red-skills-set.ts";

const accept: SignatureVerifier = () => ({ ok: true, by: "test" });

/**
 * Run something with the log redirected into nothing.
 *
 * Every refusal below is *supposed* to say so out loud, and a test
 * suite that printed each of them would bury the one line that matters
 * when something actually breaks.
 */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const release = captureTo(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const COMMIT_C = "c".repeat(40);

// ------------------------------------------------------------- the fixtures

interface FakeRevision {
  tag: string;
  commit: string;
  /** The source the commit carries, path → contents. */
  files: Record<string, string>;
}

/**
 * A remote, a git that answers for it, and the argv it was asked.
 *
 * `archive` writes a stand-in tarball naming the commit and `tar -xf`
 * expands it, so the two-command sequence is exercised rather than
 * short-circuited — a snapshot that appeared without both would hide
 * exactly the bug where one of them is issued against the wrong path.
 */
function fakeGit(revisions: readonly FakeRevision[]): {
  run: CommandRunner;
  calls: string[][];
  clones: number;
  fetches: number;
} {
  const calls: string[][] = [];
  const state = { clones: 0, fetches: 0 };
  const run: CommandRunner = (argv) => {
    const args = [...argv];
    calls.push(args);
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });

    if (args[1] === "ls-remote") {
      return ok(revisions.map((r) => `${r.commit}\trefs/tags/${r.tag}\n`).join(""));
    }
    if (args[1] === "clone") {
      const dir = args.at(-1) as string;
      state.clones++;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "HEAD"), "ref: refs/heads/main\n");
      return ok();
    }
    if (args[3] === "fetch") {
      state.fetches++;
      return ok();
    }
    if (args[3] === "archive") {
      const commit = args.at(-1) as string;
      const out = (args.find((a) => a.startsWith("--output=")) ?? "").slice("--output=".length);
      const revision = revisions.find((r) => r.commit === commit);
      if (!revision) return { code: 128, stdout: "", stderr: `fatal: not a valid object name: ${commit}` };
      writeFileSync(out, JSON.stringify(revision.files));
      return ok();
    }
    if (args[0] === "tar") {
      const tar = args[2] as string;
      const dest = args.at(-1) as string;
      const files = JSON.parse(readFileSync(tar, "utf8")) as Record<string, string>;
      for (const [rel, contents] of Object.entries(files)) {
        mkdirSync(join(dest, rel, ".."), { recursive: true });
        writeFileSync(join(dest, rel), contents);
      }
      return ok();
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${args.join(" ")}` };
  };
  return {
    run,
    calls,
    get clones() {
      return state.clones;
    },
    get fetches() {
      return state.fetches;
    },
  };
}

function sourceOf(version: string): Record<string, string> {
  return {
    "package.json": `${JSON.stringify({ name: "@reddb-io/red-skills", version })}\n`,
    "bin/red-skills-dev.mjs": "// dev shim\n",
    ".claude-plugin/marketplace.json": `${JSON.stringify({ name: "red-skills", plugins: [] })}\n`,
    "scripts/install-opencode.sh": "#!/bin/bash\n",
  };
}

const RELEASES: FakeRevision[] = [
  { tag: "v3.19.4", commit: COMMIT_A, files: sourceOf("3.19.4") },
  { tag: "v3.19.5", commit: COMMIT_B, files: sourceOf("3.19.5") },
  { tag: "v3.20.0-next.1", commit: COMMIT_C, files: sourceOf("3.20.0-next.1") },
];

interface AssetOpts {
  /** The commit the manifest declares. Defaults to the one asked for. */
  declares?: string;
  bundle?: boolean;
  /** Rewrite one artifact's bytes after the manifest was computed over them. */
  corrupt?: boolean;
  artifacts?: Record<string, string>;
}

/** A published package set on disk, exactly as a release directory has it. */
function assetsDir(commit: string, opts: AssetOpts = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "red-acquire-assets-"));
  const artifacts = opts.artifacts ?? {
    "dev.bundle.min.mjs": `// dev ${commit.slice(0, 4)}\n`,
    "verify-package-set.mjs": "// verifier\n",
  };
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  const declared = Object.entries(artifacts).map(([name, bytes]) => {
    writeFileSync(join(dir, "artifacts", name), bytes);
    return { name, size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) };
  });
  writeFileSync(
    join(dir, SET_MANIFEST_NAME),
    encodePackageSet(createPackageSetManifest(opts.declares ?? commit, declared)),
  );
  if (opts.bundle !== false) writeFileSync(join(dir, SET_BUNDLE_NAME), "{}\n");
  if (opts.corrupt) {
    const name = Object.keys(artifacts)[0] as string;
    writeFileSync(join(dir, "artifacts", name), "tampered\n");
  }
  return dir;
}

/** An asset provider that answers per commit from prepared directories. */
function assetsFor(map: Record<string, string>): AssetProvider {
  return async (req) => {
    const dir = map[req.commit];
    if (!dir) {
      return { kind: "unavailable", reason: `no package set published for ${req.commit.slice(0, 12)}` };
    }
    return directoryAssetProvider(dir)(req);
  };
}

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "red-acquire-home-"));
}

/** Everything an acquisition needs to run with no network and no cosign. */
function acquire(
  home: string,
  git: ReturnType<typeof fakeGit>,
  assets: AssetProvider,
  extra: Record<string, unknown> = {},
) {
  return acquireRedSkills({
    home,
    run: git.run,
    assets,
    verifier: accept,
    plugins: ["dev"],
    platform: "linux",
    url: "https://example.invalid/red-skills.git",
    selector: "stable",
    env: { HOME: home },
    ...extra,
  });
}

// ------------------------------------------------------------- the selectors

describe("what a selector is allowed to be", () => {
  test("the two channels, a version with or without its v, and a commit", () => {
    expect(parseSelector("stable")).toEqual({ kind: "channel", channel: "stable" });
    expect(parseSelector("next")).toEqual({ kind: "channel", channel: "next" });
    expect(parseSelector("3.19.5")).toEqual({ kind: "version", version: "3.19.5" });
    expect(parseSelector("v3.19.5")).toEqual({ kind: "version", version: "3.19.5" });
    expect(parseSelector("3.20.0-next.1")).toEqual({ kind: "version", version: "3.20.0-next.1" });
    expect(parseSelector(COMMIT_A)).toEqual({ kind: "commit", commit: COMMIT_A });
    expect(parseSelector(`commit:${COMMIT_A}`)).toEqual({ kind: "commit", commit: COMMIT_A });
  });

  test("anything else is refused rather than guessed at", () => {
    for (const raw of ["", "  ", "latest", "3.19", "v3", "main", "HEAD", "abc123", `commit:${"a".repeat(39)}`]) {
      expect(parseSelector(raw), raw).toBeNull();
    }
  });

  test("a selector reads back the way it was written", () => {
    expect(selectorLabel({ kind: "channel", channel: "next" })).toBe("next");
    expect(selectorLabel({ kind: "version", version: "3.19.5" })).toBe("3.19.5");
    expect(selectorLabel({ kind: "commit", commit: COMMIT_A })).toBe(`commit:${COMMIT_A}`);
  });
});

describe("the listing, and the order it puts releases in", () => {
  test("release tags only, sorted, with the peel lines and the noise dropped", () => {
    const out = [
      `${COMMIT_B}\trefs/tags/v3.19.5`,
      `${COMMIT_A}\trefs/tags/v3.19.4`,
      `${COMMIT_C}\trefs/tags/v3.20.0-next.1`,
      `${"d".repeat(40)}\trefs/tags/nightly`,
      `${"e".repeat(40)}\trefs/heads/main`,
      "",
    ].join("\n");
    expect(parseRemoteRevisions(out).map((r) => r.version)).toEqual([
      "3.19.4",
      "3.19.5",
      "3.20.0-next.1",
    ]);
    expect(parseRemoteRevisions(out).map((r) => r.prerelease)).toEqual([false, false, true]);
  });

  test("a prerelease sorts under its own release, and 10 after 2", () => {
    expect(compareVersions("3.20.0-next.1", "3.20.0")).toBe(-1);
    expect(compareVersions("3.20.0", "3.20.0-next.1")).toBe(1);
    expect(compareVersions("3.20.0-next.2", "3.20.0-next.10")).toBe(-1);
    expect(compareVersions("3.9.0", "3.10.0")).toBe(-1);
    expect(compareVersions("3.19.5", "3.19.5")).toBe(0);
  });

  test("the same version under two spellings resolves to one revision", () => {
    const out = [`${COMMIT_B}\trefs/tags/3.19.5`, `${COMMIT_B}\trefs/tags/v3.19.5`].join("\n");
    expect(parseRemoteRevisions(out)).toHaveLength(1);
  });
});

describe("resolution is deterministic, per channel and per pin", () => {
  const revisions: RemoteRevision[] = parseRemoteRevisions(
    RELEASES.map((r) => `${r.commit}\trefs/tags/${r.tag}`).join("\n"),
  );

  test("stable is the newest release with no prerelease part", () => {
    const r = resolveRevision({ kind: "channel", channel: "stable" }, revisions);
    expect(r).toEqual({ ok: true, commit: COMMIT_B, version: "3.19.5", tag: "v3.19.5" });
  });

  test("next reaches the prerelease stable will not", () => {
    const r = resolveRevision({ kind: "channel", channel: "next" }, revisions);
    expect(r).toEqual({ ok: true, commit: COMMIT_C, version: "3.20.0-next.1", tag: "v3.20.0-next.1" });
  });

  test("next is stable when nothing newer is published", () => {
    const released = revisions.filter((r) => !r.prerelease);
    expect(resolveRevision({ kind: "channel", channel: "next" }, released)).toEqual(
      resolveRevision({ kind: "channel", channel: "stable" }, released),
    );
  });

  test("a pinned version is exact, and an unpublished one is refused", () => {
    expect(resolveRevision({ kind: "version", version: "3.19.4" }, revisions)).toEqual({
      ok: true,
      commit: COMMIT_A,
      version: "3.19.4",
      tag: "v3.19.4",
    });
    const missing = resolveRevision({ kind: "version", version: "3.19.9" }, revisions);
    expect(missing.ok).toBe(false);
    expect(missing.ok === false && missing.reason).toContain("3.19.9");
  });

  test("a pinned commit resolves to itself, tagged or not", () => {
    expect(resolveRevision({ kind: "commit", commit: COMMIT_A }, revisions)).toEqual({
      ok: true,
      commit: COMMIT_A,
      version: "3.19.4",
      tag: "v3.19.4",
    });
    expect(resolveRevision({ kind: "commit", commit: "f".repeat(40) }, revisions)).toEqual({
      ok: true,
      commit: "f".repeat(40),
      version: null,
      tag: null,
    });
  });

  test("the same listing in any order resolves to the same commit", () => {
    const shuffled = [...revisions].reverse();
    for (const channel of ["stable", "next"] as const) {
      expect(resolveRevision({ kind: "channel", channel }, shuffled)).toEqual(
        resolveRevision({ kind: "channel", channel }, revisions),
      );
    }
  });
});

// --------------------------------------------------------- mirror and snapshot

describe("one mirror, and one snapshot per commit", () => {
  test("the argv is the mirror's: --tags --refs to list, --mirror to clone", () => {
    expect(lsRemoteArgv("u")).toEqual(["git", "ls-remote", "--tags", "--refs", "u"]);
    expect(mirrorCloneArgv("u", "d")).toContain("--mirror");
  });

  test("two versions share one clone and get two immutable snapshots", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const assets = assetsFor({ [COMMIT_A]: assetsDir(COMMIT_A), [COMMIT_B]: assetsDir(COMMIT_B) });

    const first = await quiet(() => acquire(home, git, assets, { selector: "3.19.4" }));
    const second = await quiet(() => acquire(home, git, assets, { selector: "3.19.5" }));

    expect(first.outcome).toBe("acquired");
    expect(second.outcome).toBe("acquired");
    expect(git.clones).toBe(1);
    expect(git.fetches).toBe(1);
    expect(first.mirror?.cloned).toBe(true);
    expect(second.mirror?.cloned).toBe(false);
    expect(first.mirror?.path).toBe(second.mirror?.path as string);

    expect(existsSync(redSkillsSnapshotDir(home, COMMIT_A))).toBe(true);
    expect(existsSync(redSkillsSnapshotDir(home, COMMIT_B))).toBe(true);
    expect(readdirSync(join(home, ".red", "skills", "snapshots")).sort()).toEqual([COMMIT_A, COMMIT_B]);
    // Source, and only source: an archive carries no repository with it.
    expect(existsSync(join(redSkillsSnapshotDir(home, COMMIT_A), ".git"))).toBe(false);
  });

  test("a snapshot already on disk is reused rather than re-archived", () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const mirror = redSkillsMirrorDir(home);
    expect(ensureMirror(git.run, { url: "u", dir: mirror })).toEqual({ ok: true, cloned: true });

    const first = ensureSnapshot(git.run, { mirror, home, commit: COMMIT_A });
    const again = ensureSnapshot(git.run, { mirror, home, commit: COMMIT_A });
    expect(first).toMatchObject({ ok: true, created: true });
    expect(again).toMatchObject({ ok: true, created: false });
    expect(git.calls.filter((c) => c[3] === "archive")).toHaveLength(1);
  });

  test("an interrupted clone is replaced, not fetched into", () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const mirror = redSkillsMirrorDir(home);
    mkdirSync(mirror, { recursive: true });
    writeFileSync(join(mirror, "half-a-pack"), "");
    expect(ensureMirror(git.run, { url: "u", dir: mirror })).toEqual({ ok: true, cloned: true });
    expect(git.fetches).toBe(0);
  });

  test("a commit the mirror does not carry is a refusal, and leaves no snapshot", () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const mirror = redSkillsMirrorDir(home);
    ensureMirror(git.run, { url: "u", dir: mirror });
    const missing = ensureSnapshot(git.run, { mirror, home, commit: "f".repeat(40) });
    expect(missing.ok).toBe(false);
    expect(readdirSync(join(home, ".red", "skills", "snapshots"))).toEqual([]);
  });

  test("a failed listing is reported as the command that failed", () => {
    const failing: CommandRunner = () => ({ code: 128, stdout: "", stderr: "fatal: could not read\n" });
    const listed = listRemoteRevisions(failing, "u");
    expect(listed.ok).toBe(false);
    expect(listed.ok === false && listed.reason).toContain("ls-remote");
  });

  test("a remote nobody can reach is unreachable, and is not recorded as a refused set", async () => {
    const home = fakeHome();
    const offline = fakeGit(RELEASES);
    const failing: CommandRunner = (argv) =>
      argv[1] === "ls-remote"
        ? { code: 128, stdout: "", stderr: "fatal: unable to access\n" }
        : offline.run(argv);
    const result = await quiet(() =>
      acquire(home, { ...offline, run: failing } as ReturnType<typeof fakeGit>, assetsFor({})),
    );
    expect(result.outcome).toBe("unreachable");
    expect(result.writes).toEqual([]);
    expect(readPackageSetState(home).refused).toBeNull();
  });
});

describe("against the real git", () => {
  const git = Bun.which("git");

  test.skipIf(!git)("archives a commit from a mirror cloned once", () => {
    const origin = mkdtempSync(join(tmpdir(), "red-acquire-origin-"));
    const sh = (...args: string[]) =>
      Bun.spawnSync(args, {
        cwd: origin,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "red-dev",
          GIT_AUTHOR_EMAIL: "red-dev@example.invalid",
          GIT_COMMITTER_NAME: "red-dev",
          GIT_COMMITTER_EMAIL: "red-dev@example.invalid",
        },
      });
    sh("git", "init", "--quiet", "--initial-branch=main", ".");
    writeFileSync(join(origin, "package.json"), `${JSON.stringify({ version: "3.19.4" })}\n`);
    sh("git", "add", "package.json");
    sh("git", "commit", "--quiet", "-m", "3.19.4");
    sh("git", "tag", "v3.19.4");
    writeFileSync(join(origin, "package.json"), `${JSON.stringify({ version: "3.19.5" })}\n`);
    sh("git", "add", "package.json");
    sh("git", "commit", "--quiet", "-m", "3.19.5");
    sh("git", "tag", "v3.19.5");

    const home = fakeHome();
    const { systemRunner } = require("./red-skills-acquire.ts") as typeof import("./red-skills-acquire.ts");
    const listed = listRemoteRevisions(systemRunner, origin);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    expect(listed.revisions.map((r) => r.version)).toEqual(["3.19.4", "3.19.5"]);

    const mirror = redSkillsMirrorDir(home);
    expect(ensureMirror(systemRunner, { url: origin, dir: mirror })).toEqual({ ok: true, cloned: true });
    expect(ensureMirror(systemRunner, { url: origin, dir: mirror })).toEqual({ ok: true, cloned: false });

    for (const revision of listed.revisions) {
      const snapshot = ensureSnapshot(systemRunner, { mirror, home, commit: revision.commit });
      expect(snapshot, revision.version).toMatchObject({ ok: true, created: true });
      if (!snapshot.ok) continue;
      expect(existsSync(join(snapshot.path, ".git"))).toBe(false);
      expect(JSON.parse(readFileSync(join(snapshot.path, "package.json"), "utf8")).version).toBe(
        revision.version,
      );
    }
    expect(readdirSync(join(home, ".red", "skills", "snapshots"))).toHaveLength(2);
  });
});

// --------------------------------------------------------------- the refusals

describe("assets that do not belong to the resolved commit", () => {
  const cases: [string, AssetOpts, string][] = [
    ["a manifest declaring another commit", { declares: COMMIT_A }, "cross-commit"],
    ["an artifact whose bytes were changed after signing", { corrupt: true }, "artifact"],
    ["a release with no signature bundle", { bundle: false }, "signature"],
  ];

  for (const [name, opts, failure] of cases) {
    test(`${name} is refused, and nothing is reconciled`, async () => {
      const home = fakeHome();
      const git = fakeGit(RELEASES);
      let reconciled = 0;
      const result = await quiet(() =>
        acquire(home, git, assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B, opts) })),
      );

      expect(result.outcome).toBe("refused");
      expect(result.failure).toBe(failure as never);
      expect(existsSync(redSkillsCurrentLink(home))).toBe(false);
      expect(readPackageSetState(home).active).toBeNull();
      expect(readPackageSetState(home).refused?.failure).toBeDefined();

      // And the postinstall's half: with nothing active, reconciliation
      // has nothing to converge against and does not run.
      const after = await quiet(() =>
        reconcileRedSkills({ home, reconcile: () => void reconciled++ }),
      );
      expect(after.reconciled).toBe(false);
      expect(reconciled).toBe(0);
    });
  }

  test("a cross-commit manifest is refused before a byte is cloned", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    await quiet(() => acquire(home, git, assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B, { declares: COMMIT_A }) })));
    expect(git.clones).toBe(0);
    expect(existsSync(join(home, ".red", "skills", "snapshots"))).toBe(false);
  });

  test("a release with no package set is unavailable, not refused", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const result = await quiet(() => acquire(home, git, assetsFor({})));
    expect(result.outcome).toBe("unavailable");
    expect(result.failure).toBeNull();
    expect(readPackageSetState(home).refused).toBeNull();
    expect(existsSync(redSkillsCurrentLink(home))).toBe(false);
    expect(git.clones).toBe(0);
  });

  test("a selector nothing could mean is refused before the network", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const result = await quiet(() => acquire(home, git, assetsFor({}), { selector: "main" }));
    expect(result.outcome).toBe("refused");
    expect(git.calls).toEqual([]);
  });
});

// ------------------------------------------------------------ the acquisition

describe("acquiring a revision, and then not acquiring it again", () => {
  test("the tree is the commit's source with the same commit's bundles in it", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const result = await quiet(() =>
      acquire(home, git, assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B) })),
    );

    expect(result.outcome).toBe("acquired");
    expect(result.version).toBe("3.19.5");
    expect(result.commit).toBe(COMMIT_B);
    const current = realpathSync(redSkillsCurrentLink(home));
    expect(readFileSync(join(current, "package.json"), "utf8")).toContain("3.19.5");
    // The built bundle came from the assets, the source from the commit.
    expect(readFileSync(join(current, "dist", "dev.bundle.min.mjs"), "utf8")).toContain(COMMIT_B.slice(0, 4));
    expect(existsSync(join(current, "bin", "red-skills-dev.mjs"))).toBe(true);
    // The verifier is a release artifact, not a file the tree carries.
    expect(existsSync(join(current, "dist", "verify-package-set.mjs"))).toBe(false);
    expect(existsSync(join(redSkillsCandidateDir(home, COMMIT_B), "artifacts", "verify-package-set.mjs"))).toBe(true);
    // The activation gate the OpenCode generator reads.
    expect(readFileSync(join(current, ".red", "config.yaml"), "utf8")).toContain("dev:");
  });

  test("only the bundles overlay into the tree", () => {
    expect(overlaysIntoTree("dev.bundle.min.mjs")).toBe(true);
    expect(overlaysIntoTree("memory-tokenizer.asset.cjs")).toBe(true);
    expect(overlaysIntoTree("vscode-extension-red-skills-3.19.5.vsix")).toBe(false);
    expect(overlaysIntoTree("verify-package-set.mjs")).toBe(false);
  });

  test("a second acquisition of the same commit writes nothing and asks for nothing", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const assets = assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B) });
    await quiet(() => acquire(home, git, assets));
    const calls = git.calls.length;

    const again = await quiet(() => acquire(home, git, assets));
    expect(again.outcome).toBe("current");
    expect(again.writes).toEqual([]);
    expect(again.snapshot).toBeNull();
    // One command: the listing that resolved the channel. No clone, no
    // fetch, no archive — the machine was already on the commit.
    expect(git.calls.length - calls).toBe(1);
  });

  test("the machine keeps the active revision and its rollback, and collects the rest", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const assets = assetsFor({
      [COMMIT_A]: assetsDir(COMMIT_A),
      [COMMIT_B]: assetsDir(COMMIT_B),
      [COMMIT_C]: assetsDir(COMMIT_C),
    });
    await quiet(() => acquire(home, git, assets, { selector: "3.19.4" }));
    await quiet(() => acquire(home, git, assets, { selector: "3.19.5" }));
    expect(readdirSync(join(home, ".red", "skills", "snapshots")).sort()).toEqual([COMMIT_A, COMMIT_B]);

    await quiet(() => acquire(home, git, assets, { selector: "next" }));
    expect(readdirSync(join(home, ".red", "skills", "snapshots")).sort()).toEqual([COMMIT_B, COMMIT_C]);
    expect(readdirSync(join(home, ".red", "skills", "candidates")).sort()).toEqual([COMMIT_B, COMMIT_C]);
  });
});

// ---------------------------------------------------------- the reconciliation

describe("reconciliation runs once per revision that moved", () => {
  test("after a real change, and not after an install that changed nothing", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const assets = assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B), [COMMIT_C]: assetsDir(COMMIT_C) });
    let reconciled = 0;
    const reconcile = () => void reconciled++;

    const first = await quiet(() =>
      acquireAndReconcile({ ...acquireArgs(home, git, assets), reconcile }),
    );
    expect(first.acquired.outcome).toBe("acquired");
    expect(first.reconciliation.reconciled).toBe(true);
    expect(reconciled).toBe(1);

    const second = await quiet(() =>
      acquireAndReconcile({ ...acquireArgs(home, git, assets), reconcile }),
    );
    expect(second.acquired.outcome).toBe("current");
    expect(second.acquired.writes).toEqual([]);
    expect(second.reconciliation.reconciled).toBe(false);
    expect(second.reconciliation.writes).toEqual([]);
    expect(reconciled).toBe(1);

    const moved = await quiet(() =>
      acquireAndReconcile({ ...acquireArgs(home, git, assets), selector: "next", reconcile }),
    );
    expect(moved.acquired.outcome).toBe("acquired");
    expect(reconciled).toBe(2);
  });

  test("the stamp is the identity and nothing else, so an unchanged run leaves it byte-identical", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const assets = assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B) });
    await quiet(() => acquireAndReconcile({ ...acquireArgs(home, git, assets), reconcile: () => {} }));
    const stamp = readFileSync(reconciledStampPath(home), "utf8");
    await quiet(() => acquireAndReconcile({ ...acquireArgs(home, git, assets), reconcile: () => {} }));
    expect(readFileSync(reconciledStampPath(home), "utf8")).toBe(stamp);
    expect(stamp).not.toContain("at");
  });

  test("a machine with no package set has nothing to reconcile", async () => {
    const home = fakeHome();
    let reconciled = 0;
    const result = await reconcileRedSkills({ home, reconcile: () => void reconciled++ });
    expect(result.reconciled).toBe(false);
    expect(reconciled).toBe(0);
  });
});

describe("both entry points reach the same active digest", () => {
  test("the plugin's install and red-dev update converge on one revision", async () => {
    const viaPlugin = fakeHome();
    const viaUpdate = fakeHome();
    const assets = { [COMMIT_B]: assetsDir(COMMIT_B) };
    let reconciled = 0;
    const idle = async () => 0;

    const install = fakeGit(RELEASES);
    const installPath = join(viaPlugin, "mise-install");
    const code = await quiet(() =>
      runPluginPhase("install", {
        home: viaPlugin,
        run: install.run,
        assets: assetsFor(assets),
        verifier: accept,
        plugins: ["dev"],
        platform: "linux",
        url: "https://example.invalid/red-skills.git",
        workers: idle,
        env: { HOME: viaPlugin, ASDF_INSTALL_VERSION: "stable", ASDF_INSTALL_PATH: installPath },
      }),
    );
    expect(code).toBe(0);
    await quiet(() =>
      runPluginPhase("reconcile", {
        home: viaPlugin,
        env: { HOME: viaPlugin },
        reconcile: () => void reconciled++,
      }),
    );

    // The other entry point, through the state machine `red-dev update`
    // runs: same acquisition, same surfaces, same Workers rule.
    const update = fakeGit(RELEASES);
    await quiet(() =>
      runStagedUpdate({
        home: viaUpdate,
        env: { HOME: viaUpdate },
        workers: idle,
        acquire: (stageOnly) =>
          acquireRedSkills({ ...acquireArgs(viaUpdate, update, assetsFor(assets)), stageOnly }),
        converge: async () => {
          reconciled++;
          return { hosts: [], companions: [] };
        },
        lock: async () => ({ ok: false, present: false, reason: "no workstation lock" }),
      }),
    );

    const left = readPackageSetState(viaPlugin);
    const right = readPackageSetState(viaUpdate);
    expect(left.active).toBe(right.active as string);
    expect(left.revisions[0]?.digest).toBe(right.revisions[0]?.digest as string);
    expect(left.revisions[0]?.sourceCommit).toBe(COMMIT_B);
    expect(reconciled).toBe(2);

    // mise reads the install directory; what it finds is the identity,
    // not a second copy of the tree.
    const receipt = JSON.parse(readFileSync(join(installPath, "package-set.json"), "utf8"));
    expect(receipt.sourceCommit).toBe(COMMIT_B);
    expect(receipt.digest).toBe(left.revisions[0]?.digest as string);
  });

  test("mise's own upgrade stages rather than activates while a Worker runs", async () => {
    // The Workers rule has to hold at the entry point a person did not
    // type. `mise upgrade red-skills` on a busy machine verifies the
    // complete revision and leaves `current` where it is.
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const code = await quiet(() =>
      runPluginPhase("install", {
        home,
        run: git.run,
        assets: assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B) }),
        verifier: accept,
        plugins: ["dev"],
        platform: "linux",
        url: "https://example.invalid/red-skills.git",
        workers: async () => 2,
        env: { HOME: home, ASDF_INSTALL_VERSION: "stable" },
      }),
    );
    expect(code).toBe(0);
    const state = readPackageSetState(home);
    expect(state.active).toBeNull();
    expect(state.staged?.sourceCommit).toBe(COMMIT_B);

    // mise's receipt names the revision that was fetched, not the one
    // the machine is still resolving.
    const installPath = join(home, "mise-install");
    await quiet(() =>
      runPluginPhase("install", {
        home,
        run: git.run,
        assets: assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B) }),
        verifier: accept,
        plugins: ["dev"],
        platform: "linux",
        url: "https://example.invalid/red-skills.git",
        workers: async () => 2,
        env: { HOME: home, ASDF_INSTALL_VERSION: "stable", ASDF_INSTALL_PATH: installPath },
      }),
    );
    const receipt = JSON.parse(readFileSync(join(installPath, "package-set.json"), "utf8"));
    expect(receipt.sourceCommit).toBe(COMMIT_B);
    expect(receipt.digest).toBe(state.staged?.digest as string);

    // And the run that finds the queue drained activates it, acquiring
    // nothing: the git fake would answer, and it is never asked.
    const activated = activateStagedPackageSet({ home, platform: "linux", env: { HOME: home } })!;
    expect(activated.active?.sourceCommit).toBe(COMMIT_B);
    expect(readPackageSetState(home).active).toBe(state.staged?.key as string);
  });

  test("the plugin lists the channels beside the versions, and answers latest-stable", async () => {
    const git = fakeGit(RELEASES);
    const lines: string[] = [];
    const opts = { run: git.run, out: (l: string) => lines.push(l), url: "u", env: {} };
    expect(await runPluginPhase("list-all", opts)).toBe(0);
    expect(lines[0]).toBe("stable next 3.19.4 3.19.5 3.20.0-next.1");
    expect(await runPluginPhase("latest-stable", opts)).toBe(0);
    expect(lines[1]).toBe("3.19.5");
  });

  test("a refused install is a non-zero exit, so mise records no version", async () => {
    const home = fakeHome();
    const git = fakeGit(RELEASES);
    const code = await quiet(() =>
      runPluginPhase("install", {
        home,
        run: git.run,
        assets: assetsFor({ [COMMIT_B]: assetsDir(COMMIT_B, { bundle: false }) }),
        verifier: accept,
        plugins: ["dev"],
        platform: "linux",
        url: "u",
        env: { HOME: home, ASDF_INSTALL_VERSION: "stable" },
      }),
    );
    expect(code).toBe(1);
  });
});

// ------------------------------------------------------- the online provider

describe("the release assets, over a fake GitHub", () => {
  function net(routes: Record<string, { status?: number; body?: unknown }>) {
    const asked: string[] = [];
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      asked.push(url);
      const hit = routes[url];
      if (!hit) return new Response("", { status: 404 });
      const body = hit.body;
      return new Response(
        body === undefined
          ? ""
          : typeof body === "string" || body instanceof Uint8Array
            ? (body as string)
            : JSON.stringify(body),
        { status: hit.status ?? 200 },
      );
    }) as unknown as typeof fetch;
    return { fetcher, asked };
  }

  const TAG_URL = "https://api.github.com/repos/reddb-io/red-skills/releases/tags/v3.19.5";

  test("a release with no package-set manifest is unavailable and downloads nothing", async () => {
    const { fetcher, asked } = net({ [TAG_URL]: { body: { assets: [{ name: "red-skills.tgz", browser_download_url: "https://example.invalid/tgz" }] } } });
    const dest = mkdtempSync(join(tmpdir(), "red-acquire-dest-"));
    rmSync(dest, { recursive: true, force: true });
    const outcome = await githubAssetProvider({ fetcher, env: {} })({
      commit: COMMIT_B,
      version: "3.19.5",
      tag: "v3.19.5",
      dest,
    });
    expect(outcome.kind).toBe("unavailable");
    expect(asked).toEqual([TAG_URL]);
    expect(existsSync(dest)).toBe(false);
  });

  test("a manifest from another commit is refused before the artifacts are fetched", async () => {
    const bytes = "// dev\n";
    const manifest = encodePackageSet(
      createPackageSetManifest(COMMIT_A, [
        { name: "dev.bundle.min.mjs", size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) },
      ]),
    );
    const { fetcher, asked } = net({
      [TAG_URL]: {
        body: {
          assets: [
            { name: SET_MANIFEST_NAME, browser_download_url: "https://example.invalid/manifest" },
            { name: SET_BUNDLE_NAME, browser_download_url: "https://example.invalid/bundle" },
            { name: "dev.bundle.min.mjs", browser_download_url: "https://example.invalid/dev" },
          ],
        },
      },
      "https://example.invalid/manifest": { body: manifest },
    });
    const dest = mkdtempSync(join(tmpdir(), "red-acquire-dest-"));
    const outcome = await githubAssetProvider({ fetcher, env: {} })({
      commit: COMMIT_B,
      version: "3.19.5",
      tag: "v3.19.5",
      dest,
    });
    expect(outcome).toMatchObject({ kind: "refused", failure: "cross-commit" });
    expect(asked).not.toContain("https://example.invalid/dev");
  });

  test("an untagged commit publishes no assets, and says so rather than guessing a tag", async () => {
    const { fetcher, asked } = net({});
    const outcome = await githubAssetProvider({ fetcher, env: {} })({
      commit: COMMIT_B,
      version: null,
      tag: null,
      dest: join(tmpdir(), "unused"),
    });
    expect(outcome.kind).toBe("unavailable");
    expect(asked).toEqual([]);
  });
});

/** The shared arguments of an acquisition, for the tests that spread them. */
/**
 * Acquire, then reconcile — the two halves in the order the staged
 * update walks them.
 *
 * A helper here rather than a function in the module, because the
 * composition itself moved: src/staged-update.ts walks four surfaces
 * now, and a second acquire-then-reconcile pair beside it would be free
 * to drift from the one that runs. What is worth pinning is that the
 * two halves still compose — which is what these tests do.
 */
async function acquireAndReconcile(
  opts: AcquireOptions & { reconcile?: ReconcileOptions["reconcile"] },
): Promise<{ acquired: Acquisition; reconciliation: Reconciliation }> {
  const acquired = await acquireRedSkills(opts);
  announce(acquired);
  const home = opts.home ?? "";
  const reconciliation = await reconcileRedSkills({
    home,
    ...(opts.reconcile ? { reconcile: opts.reconcile } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  return { acquired, reconciliation };
}

function acquireArgs(home: string, git: ReturnType<typeof fakeGit>, assets: AssetProvider) {
  return {
    home,
    run: git.run,
    assets,
    verifier: accept,
    plugins: ["dev"],
    platform: "linux" as const,
    url: "https://example.invalid/red-skills.git",
    selector: "stable",
    env: { HOME: home },
  };
}

describe("a commit that carries a symlink", () => {
  /** A real bare repository, because this is about what git and tar do. */
  function repoWithSymlink(): { mirror: string; commit: string; home: string } {
    const root = mkdtempSync(join(tmpdir(), "red-symlink-"));
    const work = join(root, "work");
    mkdirSync(join(work, "packages", "worker"), { recursive: true });
    writeFileSync(join(work, "packages", "worker", "CLAUDE.md"), "# the real file\n");
    symlinkSync("CLAUDE.md", join(work, "packages", "worker", "AGENTS.md"));
    writeFileSync(join(work, "package.json"), '{"name":"x"}\n');

    const git = (...args: string[]) =>
      spawnSync("git", ["-C", work, ...args], { encoding: "utf8", stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@example.com");
    git("config", "user.name", "t");
    git("add", "-A");
    git("commit", "-qm", "one");
    const commit = spawnSync("git", ["-C", work, "rev-parse", "HEAD"], { encoding: "utf8" })
      .stdout.trim();

    const mirror = join(root, "mirror.git");
    spawnSync("git", ["clone", "-q", "--bare", work, mirror], { encoding: "utf8" });
    return { mirror, commit, home: join(root, "home") };
  }

  const realGit: CommandRunner = (argv) => {
    const r = spawnSync(argv[0] as string, argv.slice(1), { encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

  test("extracts as a real symlink where the platform can make one", () => {
    const { mirror, commit, home } = repoWithSymlink();
    const result = ensureSnapshot(realGit, { mirror, home, commit, symlinks: "native" });
    expect(result).toMatchObject({ ok: true, created: true });
    if (!result.ok) return;

    const link = join(result.path, "packages", "worker", "AGENTS.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(link, "utf8")).toBe("# the real file\n");
  });

  test("writes the target path as a regular file where it cannot — the Windows case", () => {
    // Windows cannot create a symlink without a privilege a converge
    // does not have, so `tar -xf` aborted and the whole acquisition was
    // refused. One file in the tree cost that side every signed set
    // red-skills has published.
    const { mirror, commit, home } = repoWithSymlink();
    const result = ensureSnapshot(realGit, { mirror, home, commit, symlinks: "as-file" });
    expect(result).toMatchObject({ ok: true, created: true });
    if (!result.ok) return;

    const link = join(result.path, "packages", "worker", "AGENTS.md");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    // The path it pointed at, with no newline — what `git clone` writes
    // on Windows with core.symlinks false.
    expect(readFileSync(link, "utf8")).toBe("CLAUDE.md");
    // And the rest of the tree is all there.
    expect(readFileSync(join(result.path, "packages", "worker", "CLAUDE.md"), "utf8")).toBe(
      "# the real file\n",
    );
    expect(existsSync(join(result.path, "package.json"))).toBe(true);
  });
});

describe("reading symlinks out of a commit", () => {
  test("takes only mode 120000, from NUL-separated records", () => {
    const stdout =
      "100644 blob aaa1\tpackage.json\0" +
      "120000 blob bbb2\tpackages/worker/AGENTS.md\0" +
      "040000 tree ccc3\tdocs\0";
    expect(parseSymlinkEntries(stdout)).toEqual([
      { path: "packages/worker/AGENTS.md", blob: "bbb2" },
    ]);
  });

  test("survives a path with a newline in it, which is why -z is asked for", () => {
    const stdout = "120000 blob d4\tweird\nname.md\0";
    expect(parseSymlinkEntries(stdout)).toEqual([{ path: "weird\nname.md", blob: "d4" }]);
  });

  test("the excludes go before -f, the ordering both tars agree on", () => {
    expect(extractArgv("/tmp/a.tar", "/tmp/dest", ["x/y.md"])).toEqual([
      "tar",
      "--exclude=x/y.md",
      "-xf",
      "/tmp/a.tar",
      "-C",
      "/tmp/dest",
    ]);
    expect(extractArgv("/tmp/a.tar", "/tmp/dest")).toEqual([
      "tar",
      "-xf",
      "/tmp/a.tar",
      "-C",
      "/tmp/dest",
    ]);
  });
});
