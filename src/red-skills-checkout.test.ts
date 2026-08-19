/**
 * A development checkout: what identifies it, what it reuses, what it
 * builds, and what it is never allowed to touch.
 *
 * The fixtures are real directories, because every property here is a
 * property of bytes on disk. Two copies of one checkout in two temp
 * directories prove the identity is content and not path; a checkout
 * whose digest is taken before and after a sync proves the acceptance
 * criterion the whole design exists for — a build that writes into the
 * tree somebody is editing would pass every other test in this file.
 *
 * `git` is faked for the identity's two questions (`rev-parse`, `status
 * --porcelain`) so a fixture can be dirty, clean, or not a repository at
 * all without a repository being created for each; the build is faked
 * the same way and writes the bundles a real `bun run build` would, so
 * the sequence — reuse what the commit published, build only the rest —
 * is exercised rather than short-circuited.
 */

import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { captureTo } from "./log.ts";
import { directoryAssetProvider, type AssetProvider, type CommandRunner } from "./red-skills-acquire.ts";
import {
  checkoutAssetGaps,
  checkoutDigest,
  checkoutExcludes,
  checkoutIdentity,
  checkoutLabel,
  checkoutPathOf,
  readCheckoutReceipt,
  redSkillsCheckoutDir,
  syncRedSkillsCheckout,
  type AssetBuilder,
} from "./red-skills-checkout.ts";
import { runPluginPhase } from "./red-skills-mise-plugin.ts";
import {
  createPackageSetManifest,
  encodePackageSet,
  readPackageSetState,
  redSkillsCurrentLink,
  redSkillsSetReport,
  redSkillsSetRows,
  SET_BUNDLE_NAME,
  SET_MANIFEST_NAME,
  treeDigest,
} from "./red-skills-set.ts";

const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);

/** Run something with the log redirected into nothing. */
async function quiet<T>(fn: () => T | Promise<T>): Promise<T> {
  const release = captureTo(() => {});
  try {
    return await fn();
  } finally {
    release();
  }
}

// ------------------------------------------------------------- the fixtures

/**
 * A RedSkills checkout on disk: the payload contract every set must
 * carry, plus whatever the test wants to differ.
 */
function checkout(extra: Record<string, string> = {}, version = "3.20.0"): string {
  const dir = mkdtempSync(join(tmpdir(), "red-checkout-"));
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "@reddb-io/red-skills", version, scripts: { build: "bun run bundle" } }, null, 2)}\n`,
    ".claude-plugin/marketplace.json": `${JSON.stringify({ name: "red-skills", plugins: [] })}\n`,
    ".agents/plugins/marketplace.json": `${JSON.stringify({ name: "red-skills", plugins: [] })}\n`,
    "bin/red-skills.mjs": "// shim\n",
    "scripts/install-opencode.sh": "#!/bin/bash\n",
    "scripts/install-pi.sh": "#!/bin/bash\n",
    "src/dev.ts": "export const dev = 1;\n",
    ...extra,
  };
  for (const [rel, contents] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), contents);
  }
  return dir;
}

/** A `git` that answers the two questions the identity asks, and nothing else. */
function fakeGit(opts: { commit?: string | null; dirty?: boolean } = {}): CommandRunner {
  const commit = opts.commit === undefined ? COMMIT_A : opts.commit;
  return (argv) => {
    if (argv[0] === "git" && argv[3] === "rev-parse") {
      return commit === null
        ? { code: 128, stdout: "", stderr: "fatal: not a git repository" }
        : { code: 0, stdout: `${commit}\n`, stderr: "" };
    }
    if (argv[0] === "git" && argv[3] === "status") {
      return { code: 0, stdout: opts.dirty ? " M src/dev.ts\n" : "", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${argv.join(" ")}` };
  };
}

/** A build that writes the bundles the checkout's own `bun run build` would. */
function fakeBuild(): { build: AssetBuilder; calls: BuildCall[] } {
  const calls: BuildCall[] = [];
  const build: AssetBuilder = (req) => {
    calls.push({ tree: req.tree, missing: [...req.missing] });
    mkdirSync(join(req.tree, "dist"), { recursive: true });
    for (const name of req.missing) writeFileSync(join(req.tree, "dist", name), `// built ${name}\n`);
    return { ok: true, built: [...req.missing] };
  };
  return { build, calls };
}

interface BuildCall {
  tree: string;
  missing: string[];
}

/** A published release's assets on disk, exactly as a release directory has them. */
function assetsDir(commit: string, artifacts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "red-checkout-assets-"));
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  const declared = Object.entries(artifacts).map(([name, bytes]) => {
    writeFileSync(join(dir, "artifacts", name), bytes);
    return { name, size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) };
  });
  writeFileSync(join(dir, SET_MANIFEST_NAME), encodePackageSet(createPackageSetManifest(commit, declared)));
  writeFileSync(join(dir, SET_BUNDLE_NAME), "{}\n");
  return dir;
}

function assetsFor(map: Record<string, string>): AssetProvider {
  return async (req) => {
    const dir = map[req.commit];
    if (!dir) return { kind: "unavailable", reason: `nothing published for ${req.commit.slice(0, 12)}` };
    return directoryAssetProvider(dir)(req);
  };
}

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "red-checkout-home-"));
}

/** Everything a sync needs with no network, no cosign and no real build. */
function sync(
  home: string,
  dir: string,
  extra: Partial<Parameters<typeof syncRedSkillsCheckout>[0]> = {},
) {
  const built = fakeBuild();
  return syncRedSkillsCheckout({
    home,
    dir,
    run: fakeGit(),
    build: built.build,
    plugins: ["dev"],
    platform: "linux",
    env: { HOME: home },
    ...extra,
  });
}

// ------------------------------------------------------------- the selector

describe("how a checkout is spelled where a version would go", () => {
  test("`path:` and nothing else, so a typo cannot resolve to a release", () => {
    expect(checkoutPathOf("path:/srv/red-skills")).toBe("/srv/red-skills");
    expect(checkoutPathOf("  path:/srv/red-skills  ")).toBe("/srv/red-skills");
    expect(checkoutPathOf("stable")).toBeNull();
    expect(checkoutPathOf("3.19.5")).toBeNull();
    expect(checkoutPathOf("/srv/red-skills")).toBeNull();
    expect(checkoutPathOf("path:")).toBeNull();
  });

  test("a relative path is resolved, so the selector names one directory", () => {
    expect(checkoutPathOf("path:.")).toBe(process.cwd());
  });

  test("a checkout reads back the way it was written", () => {
    expect(checkoutLabel("/srv/red-skills")).toBe("path:/srv/red-skills");
  });
});

// ------------------------------------------------------------- the identity

describe("the identity of a checkout is its content, not its path", () => {
  test("two directories holding the same bytes are one revision", async () => {
    const left = checkout();
    const right = mkdtempSync(join(tmpdir(), "red-checkout-elsewhere-"));
    rmSync(right, { recursive: true, force: true });
    cpSync(left, right, { recursive: true });

    const a = checkoutIdentity(left, { run: fakeGit() });
    const b = checkoutIdentity(right, { run: fakeGit() });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.identity.content).toBe(b.identity.content);
    expect(a.identity.key).toBe(b.identity.key);
    expect(a.identity.dir).not.toBe(b.identity.dir);
  });

  test("one edited byte is a different revision", () => {
    const dir = checkout();
    const before = checkoutIdentity(dir, { run: fakeGit() });
    writeFileSync(join(dir, "src", "dev.ts"), "export const dev = 2;\n");
    const after = checkoutIdentity(dir, { run: fakeGit() });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.identity.content).not.toBe(before.identity.content);
  });

  test("`.git` and `node_modules` are not content", () => {
    expect(checkoutExcludes(".git/index")).toBe(true);
    expect(checkoutExcludes("plugins/dev/node_modules/x/index.js")).toBe(true);
    expect(checkoutExcludes("src/dev.ts")).toBe(false);

    const dir = checkout();
    const bare = checkoutDigest(dir);
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "index"), "whatever\n");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "// dep\n");
    expect(checkoutDigest(dir)).toBe(bare);
  });

  test("the version says dev, so a checkout is never mistaken for its release", () => {
    const read = checkoutIdentity(checkout({}, "3.20.0"), { run: fakeGit() });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.identity.version).toMatch(/^3\.20\.0-dev\.[0-9a-f]{8}$/);
    expect(read.identity.key).toBe(`${read.identity.version}+${read.identity.content.slice(0, 12)}`);
  });

  test("a dirty checkout claims no commit, a clean one claims its own", () => {
    const dir = checkout();
    const clean = checkoutIdentity(dir, { run: fakeGit({ dirty: false }) });
    const dirty = checkoutIdentity(dir, { run: fakeGit({ dirty: true }) });
    expect(clean.ok && dirty.ok).toBe(true);
    if (!clean.ok || !dirty.ok) return;
    expect(clean.identity.sourceCommit).toBe(COMMIT_A);
    expect(dirty.identity.commit).toBe(COMMIT_A);
    expect(dirty.identity.dirty).toBe(true);
    expect(dirty.identity.sourceCommit).toBe("");
    // The identity itself is the content either way: dirtiness decides
    // what may be reused, never what this revision is called.
    expect(dirty.identity.key).toBe(clean.identity.key);
  });

  test("an unreleased checkout with no repository at all still has one", () => {
    const read = checkoutIdentity(checkout(), { run: fakeGit({ commit: null }) });
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.identity.commit).toBeNull();
    expect(read.identity.sourceCommit).toBe("");
    expect(read.identity.content).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a directory that is not a checkout is refused rather than guessed at", () => {
    const empty = mkdtempSync(join(tmpdir(), "red-checkout-empty-"));
    expect(checkoutIdentity(empty, { run: fakeGit() }).ok).toBe(false);
    expect(checkoutIdentity(join(empty, "nope"), { run: fakeGit() }).ok).toBe(false);

    const unversioned = checkout({ "package.json": `${JSON.stringify({ name: "x" })}\n` });
    expect(checkoutIdentity(unversioned, { run: fakeGit() }).ok).toBe(false);
  });
});

// ---------------------------------------------------------------- the sync

describe("what a sync builds, and what it leaves alone", () => {
  test("the checkout is byte-for-byte unchanged, `.git` included", async () => {
    const home = fakeHome();
    const dir = checkout();
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "// dep\n");
    const before = treeDigest(dir);

    const result = await quiet(() => sync(home, dir));
    expect(result.outcome).toBe("synced");
    expect(treeDigest(dir)).toBe(before);
    expect(existsSync(join(dir, "dist"))).toBe(false);
  });

  test("missing assets are built into digest-keyed staging", async () => {
    const home = fakeHome();
    const dir = checkout();
    const built = fakeBuild();

    const result = await quiet(() => sync(home, dir, { build: built.build }));
    expect(result.outcome).toBe("synced");
    expect(result.built).toEqual(["dev.bundle.min.mjs"]);
    expect(result.reused).toEqual([]);
    expect(result.staging).toBe(redSkillsCheckoutDir(home, result.identity?.key ?? ""));
    // Built inside the staging that is renamed into place, and never
    // inside the checkout — the whole reason the source is copied first.
    expect(built.calls[0]?.tree).toBe(
      join(redSkillsCheckoutDir(home, `.staging-${result.identity?.key ?? ""}`), "tree"),
    );
    expect(existsSync(join(result.staging ?? "", "tree", "dist", "dev.bundle.min.mjs"))).toBe(true);

    const receipt = readCheckoutReceipt(result.staging ?? "");
    expect(receipt?.key).toBe(result.identity?.key ?? "");
    expect(receipt?.built).toEqual(["dev.bundle.min.mjs"]);
  });

  test("the machine ends on the checkout, recorded as a checkout and unsigned", async () => {
    const home = fakeHome();
    const result = await quiet(() => sync(home, checkout()));
    expect(result.outcome).toBe("synced");

    const state = readPackageSetState(home);
    expect(state.active).toBe(result.identity?.key ?? "");
    expect(state.revisions[0]?.kind).toBe("checkout");
    expect(state.revisions[0]?.trust).toBe("unsigned");
    expect(existsSync(redSkillsCurrentLink(home))).toBe(true);
    expect(existsSync(join(redSkillsCurrentLink(home), "dist", "dev.bundle.min.mjs"))).toBe(true);

    const rows = redSkillsSetRows(redSkillsSetReport(home));
    expect(rows[0]?.status).toBe("warn");
    expect(rows[0]?.detail).toContain("development checkout");
  });

  test("a checkout that cannot serve the hosts is refused before anything moves", async () => {
    const home = fakeHome();
    const dir = checkout();
    rmSync(join(dir, "scripts", "install-pi.sh"));

    const result = await quiet(() => sync(home, dir));
    expect(result.outcome).toBe("refused");
    expect(result.failure).toBe("payload");
    expect(readPackageSetState(home).active).toBeNull();
    expect(existsSync(redSkillsCurrentLink(home))).toBe(false);
  });

  test("a build that produces nothing is a refusal, not a half-staged revision", async () => {
    const home = fakeHome();
    const refuse: AssetBuilder = () => ({ ok: false, reason: "the checkout's build produced no dev.bundle.min.mjs" });

    const result = await quiet(() => sync(home, checkout(), { build: refuse }));
    expect(result.outcome).toBe("refused");
    expect(result.failure).toBe("artifact");
    expect(result.staging === null || !existsSync(result.staging)).toBe(true);
    expect(readPackageSetState(home).active).toBeNull();
  });

  test("only the assets a set carries are asked for", () => {
    const tree = checkout();
    expect(checkoutAssetGaps(tree, ["dev", "memory"])).toEqual([
      "dev.bundle.min.mjs",
      "memory.bundle.min.mjs",
    ]);
    mkdirSync(join(tree, "dist"), { recursive: true });
    writeFileSync(join(tree, "dist", "dev.bundle.min.mjs"), "// there\n");
    expect(checkoutAssetGaps(tree, ["dev", "memory"])).toEqual(["memory.bundle.min.mjs"]);
  });
});

// -------------------------------------------------------------- the assets

describe("same commit, or built here", () => {
  test("a clean checkout reuses what its own commit published", async () => {
    const home = fakeHome();
    const dir = checkout();
    const built = fakeBuild();
    const assets = assetsFor({
      [COMMIT_A]: assetsDir(COMMIT_A, {
        "dev.bundle.min.mjs": "// published dev\n",
        "verify-package-set.mjs": "// verifier\n",
      }),
    });

    const result = await quiet(() =>
      sync(home, dir, { run: fakeGit({ dirty: false }), assets, build: built.build }),
    );
    expect(result.outcome).toBe("synced");
    expect(result.reused).toEqual(["dev.bundle.min.mjs"]);
    expect(result.built).toEqual([]);
    // Nothing to build, and the builder is told so rather than skipped.
    expect(built.calls[0]?.missing).toEqual([]);
    expect(readFileSync(join(result.staging ?? "", "tree", "dist", "dev.bundle.min.mjs"), "utf8")).toBe(
      "// published dev\n",
    );
    // Only the bundles overlay; the rest of the release is not the tree's.
    expect(existsSync(join(result.staging ?? "", "tree", "dist", "verify-package-set.mjs"))).toBe(false);
  });

  test("assets declaring another commit are refused, and nothing is staged", async () => {
    const home = fakeHome();
    const assets: AssetProvider = async (req) =>
      directoryAssetProvider(assetsDir(COMMIT_B, { "dev.bundle.min.mjs": "// other\n" }))(req);

    const result = await quiet(() => sync(home, checkout(), { run: fakeGit({ dirty: false }), assets }));
    expect(result.outcome).toBe("refused");
    expect(result.failure).toBe("cross-commit");
    expect(readPackageSetState(home).active).toBeNull();
    expect(readPackageSetState(home).refused?.failure).toBe("cross-commit");
  });

  test("a dirty checkout reuses nothing, because the release is not these bytes", async () => {
    const home = fakeHome();
    const built = fakeBuild();
    const assets = assetsFor({
      [COMMIT_A]: assetsDir(COMMIT_A, { "dev.bundle.min.mjs": "// published dev\n" }),
    });

    const result = await quiet(() =>
      sync(home, checkout(), { run: fakeGit({ dirty: true }), assets, build: built.build }),
    );
    expect(result.outcome).toBe("synced");
    expect(result.reused).toEqual([]);
    expect(result.built).toEqual(["dev.bundle.min.mjs"]);
    expect(readFileSync(join(result.staging ?? "", "tree", "dist", "dev.bundle.min.mjs"), "utf8")).toBe(
      "// built dev.bundle.min.mjs\n",
    );
  });

  test("a release with no package set is not a refusal — the assets are simply built", async () => {
    const home = fakeHome();
    const result = await quiet(() =>
      sync(home, checkout(), { run: fakeGit({ dirty: false }), assets: assetsFor({}) }),
    );
    expect(result.outcome).toBe("synced");
    expect(result.built).toEqual(["dev.bundle.min.mjs"]);
    expect(readPackageSetState(home).refused).toBeNull();
  });
});

// ---------------------------------------------------------- the second run

describe("a sync with nothing to do does nothing", () => {
  test("the staging is reused and no host state is written", async () => {
    const home = fakeHome();
    const dir = checkout();
    const first = await quiet(() => sync(home, dir));
    expect(first.outcome).toBe("synced");
    expect(first.staged).toBe(true);

    const built = fakeBuild();
    const stateBefore = readFileSync(join(home, ".red", "skills", "package-set.json"), "utf8");
    const stagingBefore = treeDigest(first.staging ?? "");

    const second = await quiet(() => sync(home, dir, { build: built.build }));
    expect(second.outcome).toBe("current");
    expect(second.staged).toBe(false);
    expect(second.writes).toEqual([]);
    expect(built.calls).toEqual([]);
    expect(second.staging).toBe(first.staging);
    expect(treeDigest(second.staging ?? "")).toBe(stagingBefore);
    expect(readFileSync(join(home, ".red", "skills", "package-set.json"), "utf8")).toBe(stateBefore);
    expect(second.reused).toEqual(first.reused);
    expect(second.built).toEqual(first.built);
  });

  test("an edit is a new staging, and the previous revision is the rollback", async () => {
    const home = fakeHome();
    const dir = checkout();
    const first = await quiet(() => sync(home, dir));
    writeFileSync(join(dir, "src", "dev.ts"), "export const dev = 2;\n");
    const second = await quiet(() => sync(home, dir));

    expect(second.outcome).toBe("synced");
    expect(second.identity?.key).not.toBe(first.identity?.key);
    const state = readPackageSetState(home);
    expect(state.active).toBe(second.identity?.key ?? "");
    expect(state.revisions[1]?.key).toBe(first.identity?.key ?? "");
    // The staging past the retention is collected, so a day of editing
    // does not leave a directory per keystroke.
    expect(existsSync(second.staging ?? "")).toBe(true);
  });

  test("an interrupted staging is rebuilt rather than activated", async () => {
    const home = fakeHome();
    const dir = checkout();
    const read = checkoutIdentity(dir, { run: fakeGit() });
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    // A directory with the right name and no receipt: what a sync killed
    // halfway through would leave if it staged in place.
    const staging = redSkillsCheckoutDir(home, read.identity.key);
    mkdirSync(join(staging, "tree"), { recursive: true });
    writeFileSync(join(staging, "tree", "package.json"), "{}\n");

    const built = fakeBuild();
    const result = await quiet(() => sync(home, dir, { build: built.build }));
    expect(result.outcome).toBe("synced");
    expect(result.staged).toBe(true);
    expect(built.calls).toHaveLength(1);
    expect(readCheckoutReceipt(staging)?.key).toBe(read.identity.key);
  });
});

// ------------------------------------------------------------ the override

describe("only an explicit sync advances a checkout", () => {
  test("`mise upgrade` on a path override acquires nothing", async () => {
    const home = fakeHome();
    const dir = checkout();
    const installPath = join(fakeHome(), "installs", "red-skills-set", "path");

    const code = await quiet(() =>
      runPluginPhase("install", {
        home,
        selector: `path:${dir}`,
        env: { HOME: home, ASDF_INSTALL_PATH: installPath },
        // Anything reaching a git or a network here is the bug: a path
        // override must be decided before either is consulted.
        run: () => {
          throw new Error("mise must not acquire a path override");
        },
      }),
    );

    expect(code).toBe(0);
    expect(readPackageSetState(home).active).toBeNull();
    expect(existsSync(redSkillsCurrentLink(home))).toBe(false);
    const receipt = JSON.parse(readFileSync(join(installPath, "package-set.json"), "utf8")) as {
      checkout?: string;
    };
    expect(receipt.checkout).toBe(dir);
  });

  test("an unpinned update leaves a machine on its checkout", async () => {
    const home = fakeHome();
    const dir = checkout();
    await quiet(() => sync(home, dir));
    const before = readFileSync(join(home, ".red", "skills", "package-set.json"), "utf8");

    const { acquireRedSkills } = await import("./red-skills-acquire.ts");
    const result = await quiet(() =>
      acquireRedSkills({
        home,
        env: { HOME: home },
        run: () => {
          throw new Error("an unpinned update must not reach the remote");
        },
      }),
    );

    expect(result.outcome).toBe("current");
    expect(result.reason).toContain("development checkout");
    expect(readFileSync(join(home, ".red", "skills", "package-set.json"), "utf8")).toBe(before);
  });
});
