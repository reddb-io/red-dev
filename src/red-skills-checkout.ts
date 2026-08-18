/**
 * A development checkout as a package set, without calling it a release.
 *
 * ADR 0010 and ADR 0012 give this machine one acquisition: a channel
 * resolves to a commit, the commit is archived into an immutable
 * snapshot, the release's assets are overlaid from *that* commit, the
 * signed manifest is verified, and only then does `current` move. That
 * is the right shape for something somebody published. It is the wrong
 * shape for the tree a person is editing: a working checkout has no
 * release, frequently no tag, usually uncommitted edits, and never a
 * signature — and the four properties above would each refuse it.
 *
 * So a checkout is admitted through its own door, and the door is
 * narrow on purpose.
 *
 * ## The identity is the content, never the path
 *
 * `~/src/red-skills` and `/tmp/wt/red-skills` holding the same bytes are
 * the same revision, and a machine that synced one has nothing to do for
 * the other. That is what makes a checkout addressable at all: a
 * revision key derived from where a directory happens to sit would
 * change when somebody moved it, and every downstream comparison — is
 * this active, is it staged, were the hosts reconciled against it —
 * would silently answer about a path rather than about a tree.
 *
 * The digest is taken over the source and only the source. `.git` is
 * excluded because it is version-control state rather than content: a
 * `git status` writes an index, and an identity that moved when you
 * *looked* at the repository would be no identity. `node_modules` is
 * excluded because it is the package manager's, and the acceptance
 * criterion this file carries says neither sync nor build may treat
 * package-manager-owned files as ours.
 *
 * ## The version says `dev`, in every place a version is printed
 *
 * The identity's version is the checkout's own with `-dev.<content8>`
 * appended, so `3.20.0` becomes `3.20.0-dev.4f2c81ae`. A checkout that
 * borrowed the bare version would be indistinguishable, in the state
 * file and in `red-dev doctor`, from the release it was branched from —
 * and the whole point of the override is to run something that is *not*
 * that release.
 *
 * ## Same commit, or build it here
 *
 * A checkout is source; the bundles the hosts load are built. Where the
 * checkout is clean at a commit, that commit's published assets describe
 * exactly these bytes and are reused — one download instead of a build.
 * Where it is dirty, they describe bytes that are no longer there, so
 * they are not reused at all: overlaying them would produce a tree whose
 * source says one thing and whose bundles say another, which is the
 * cross-commit failure ADR 0012 refuses under a different name. Assets
 * declared for some *other* commit are refused outright, exactly as they
 * are online.
 *
 * ## The build runs in the staging, so the checkout never moves
 *
 * The source is copied into `~/.red-skills/checkouts/<key>/tree` first
 * and the build runs there. A build in the checkout would write `dist/`
 * into a directory Git is tracking, which is the other half of the
 * acceptance criterion — and it would also change the content the
 * identity was just computed over, so the sync would be naming a
 * revision that no longer exists by the time it activated it. The digest
 * is recomputed at the end and the sync refuses if it moved, which makes
 * "the checkout is byte-for-byte unchanged" a property of this code
 * rather than a promise about it.
 *
 * ## Explicitly, or not at all
 *
 * `red-dev red-skills sync <path>` is the only thing that advances a
 * checkout. `mise upgrade` cannot: the plugin's install phase recognises
 * a `path:` override and declines it without acquiring anything, because
 * mise's job is to record which version a tool is on and a working tree
 * moves for reasons mise has no way to see. `red-dev update` cannot
 * either, for the same reason — an unpinned update leaves a machine on
 * its checkout instead of quietly replacing it with `stable`.
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { redSkillsPluginNames } from "./red-skills-plugins.ts";
import {
  overlaysIntoTree,
  redSkillsRoot,
  systemRunner,
  type AssetProvider,
  type CommandRunner,
} from "./red-skills-acquire.ts";
import {
  convergeRedSkillsPackageSet,
  corePayloadGaps,
  hostActivationConfig,
  parsePackageSetManifest,
  readPackageSetState,
  recordPackageSetRefusal,
  revisionKey,
  SET_MANIFEST_NAME,
  setArtifactsDir,
  treeDigest,
  type PackageSetIdentity,
  type SetFailure,
} from "./red-skills-set.ts";

// ------------------------------------------------------------- the selector

/**
 * How a checkout is spelled where a version would go.
 *
 * mise's own word for the same thing, so a `[tools]` entry reading
 * `red-skills-set = "path:/home/me/src/red-skills"` says to mise and to
 * red-dev what it appears to say. Nothing bare is accepted: a directory
 * name and a channel name are both just words, and a selector that
 * guessed between them would install a release for a typo'd path.
 */
export const CHECKOUT_PREFIX = "path:";

/** The checkout a selector names, absolute, or null. PURE. */
export function checkoutPathOf(raw: string): string | null {
  const value = raw.trim();
  if (!value.startsWith(CHECKOUT_PREFIX)) return null;
  const path = value.slice(CHECKOUT_PREFIX.length).trim();
  return path === "" ? null : resolve(path);
}

/** How a checkout selector is written back into a log line. PURE. */
export function checkoutLabel(dir: string): string {
  return `${CHECKOUT_PREFIX}${dir}`;
}

// ------------------------------------------------------------- the identity

/**
 * What a checkout carries that is not its content.
 *
 * A path segment rather than a prefix, so a nested `node_modules` and a
 * submodule's `.git` are excluded wherever they sit — which is where
 * they actually are in a workspace repository.
 */
export const CHECKOUT_EXCLUDED: readonly string[] = [".git", "node_modules"];

/** Whether a path relative to the checkout root is content. PURE. */
export function checkoutExcludes(rel: string): boolean {
  return rel.split(/[\\/]/).some((segment) => CHECKOUT_EXCLUDED.includes(segment));
}

/**
 * The content digest of one checkout: every source file's path and bytes.
 *
 * The same digest the package set uses for a composed tree, over the
 * same relative paths, so two checkouts of the same content in two
 * directories — a worktree and its origin, a copy on another machine —
 * produce one identity.
 */
export function checkoutDigest(dir: string): string {
  return treeDigest(dir, { skip: checkoutExcludes });
}

/** One development checkout, as everything downstream refers to it. */
export interface CheckoutIdentity {
  /** Where it was read from. Deliberately not an input to anything below. */
  dir: string;
  /** sha256 over the source content. The same content anywhere is this. */
  content: string;
  /** `HEAD`, or null for a checkout with no commit at all. */
  commit: string | null;
  /** Whether the worktree differs from `HEAD`. False when there is no HEAD. */
  dirty: boolean;
  /** The checkout's own version with `-dev.<content8>`, never a release's. */
  version: string;
  /** `<version>+<content12>` — the revision key and the staging directory. */
  key: string;
  /**
   * The commit the staged tree may claim, which is `HEAD` only when the
   * worktree matches it. A dirty checkout is not its commit, and a
   * revision that named one would print `@<commit>` about bytes that
   * commit never had.
   */
  sourceCommit: string;
}

const CHECKOUT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const HEX40 = /^[0-9a-f]{40}$/;

export type CheckoutRead =
  | { ok: true; identity: CheckoutIdentity }
  | { ok: false; reason: string };

/**
 * Read one checkout's identity, without writing a byte into it.
 *
 * `git rev-parse` and `git status --porcelain` are the only two
 * questions asked of Git, and neither is required to succeed: a
 * directory exported from an archive, or one whose Git is not installed,
 * is an unreleased checkout with no commit rather than an error. What is
 * required is a `package.json` carrying a version, because that is the
 * one field the set's identity cannot be invented for.
 */
export function checkoutIdentity(dir: string, opts: { run?: CommandRunner } = {}): CheckoutRead {
  const root = resolve(dir);
  if (!existsSync(root)) return { ok: false, reason: `${root} is not there` };
  const pkg = join(root, "package.json");
  if (!existsSync(pkg)) {
    return { ok: false, reason: `${root} carries no package.json, so it is not a RedSkills checkout` };
  }

  let version: string;
  try {
    const parsed = JSON.parse(readFileSync(pkg, "utf8")) as { version?: unknown };
    if (typeof parsed.version !== "string" || !CHECKOUT_VERSION.test(parsed.version)) {
      return { ok: false, reason: `${root}/package.json declares no usable version` };
    }
    version = parsed.version;
  } catch {
    return { ok: false, reason: `${root}/package.json is not readable JSON` };
  }

  const run = opts.run ?? systemRunner;
  const head = run(["git", "-C", root, "rev-parse", "HEAD"]);
  const commit = head.code === 0 && HEX40.test(head.stdout.trim()) ? head.stdout.trim() : null;
  const status = commit === null ? null : run(["git", "-C", root, "status", "--porcelain"]);
  const dirty = status !== null && (status.code !== 0 || status.stdout.trim() !== "");

  const content = checkoutDigest(root);
  const devVersion = `${version}-dev.${content.slice(0, 8)}`;
  const identity: CheckoutIdentity = {
    dir: root,
    content,
    commit,
    dirty,
    version: devVersion,
    key: revisionKey({ version: devVersion, digest: content, sourceCommit: "" }),
    sourceCommit: commit !== null && !dirty ? commit : "",
  };
  return { ok: true, identity };
}

/** The identity the package set records for one checkout. PURE. */
export function checkoutPackageIdentity(identity: CheckoutIdentity): PackageSetIdentity {
  return { version: identity.version, digest: identity.content, sourceCommit: identity.sourceCommit };
}

// -------------------------------------------------------------- the staging

/** `~/.red-skills/checkouts` — where a checkout's built trees are keyed by digest. */
export function redSkillsCheckoutRoot(home: string): string {
  return join(redSkillsRoot(home), "checkouts");
}

/** `~/.red-skills/checkouts/<version>+<content12>` — one staged checkout. */
export function redSkillsCheckoutDir(home: string, key: string): string {
  return join(redSkillsCheckoutRoot(home), key);
}

/** The one file that says a staging directory is finished, and of what. */
export function checkoutReceiptPath(staging: string): string {
  return join(staging, "checkout.json");
}

/**
 * What a finished staging directory records about itself.
 *
 * Written last and named by the same key as its directory, so a staging
 * interrupted halfway is a directory with no receipt — indistinguishable
 * from one that was never started, and therefore rebuilt rather than
 * activated.
 */
export interface CheckoutReceipt {
  schema: 1;
  key: string;
  content: string;
  commit: string | null;
  dirty: boolean;
  /** Asset basenames overlaid from the release published for `commit`. */
  reused: string[];
  /** Asset basenames this machine built, because nothing published them. */
  built: string[];
}

/** The receipt a finished staging carries, or null. */
export function readCheckoutReceipt(staging: string): CheckoutReceipt | null {
  const path = checkoutReceiptPath(staging);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<CheckoutReceipt>;
    if (parsed.schema !== 1 || typeof parsed.key !== "string" || typeof parsed.content !== "string") {
      return null;
    }
    return {
      schema: 1,
      key: parsed.key,
      content: parsed.content,
      commit: typeof parsed.commit === "string" ? parsed.commit : null,
      dirty: parsed.dirty === true,
      reused: Array.isArray(parsed.reused) ? parsed.reused.filter((n): n is string => typeof n === "string") : [],
      built: Array.isArray(parsed.built) ? parsed.built.filter((n): n is string => typeof n === "string") : [],
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the build

export interface BuildRequest {
  /** The staged copy of the checkout. The build runs here and writes here. */
  tree: string;
  /** The asset basenames `tree/dist` still has to carry, in order. */
  missing: readonly string[];
}

export type BuildOutcome = { ok: true; built: string[] } | { ok: false; reason: string };

export type AssetBuilder = (req: BuildRequest) => BuildOutcome;

/** Which of the assets a set must carry are not in the staged tree yet. PURE over the tree. */
export function checkoutAssetGaps(tree: string, plugins: readonly string[]): string[] {
  return plugins
    .map((name) => `${name}.bundle.min.mjs`)
    .filter((name) => !existsSync(join(tree, "dist", name)));
}

/**
 * Build the missing assets with the checkout's own build script.
 *
 * The checkout's script rather than a build red-dev knows how to
 * perform: red-dev has no opinion about how RedSkills is bundled, and
 * one written here would be a second build to keep in step with the
 * repository's own. A checkout that declares no `build` is refused with
 * that sentence, which is a one-line fix in the tree rather than a
 * mystery about a missing bundle.
 */
export function checkoutAssetBuilder(opts: { run?: CommandRunner } = {}): AssetBuilder {
  const run = opts.run ?? systemRunner;
  return (req) => {
    if (req.missing.length === 0) return { ok: true, built: [] };

    let scripts: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(readFileSync(join(req.tree, "package.json"), "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      scripts = parsed.scripts ?? {};
    } catch {
      return { ok: false, reason: "the staged checkout carries no readable package.json" };
    }
    if (typeof scripts["build"] !== "string") {
      return {
        ok: false,
        reason: `the checkout declares no build script, and ${req.missing.join(", ")} is not in its dist/`,
      };
    }

    const built = run(["bun", "run", "build"], { cwd: req.tree });
    if (built.code !== 0) {
      return { ok: false, reason: `bun run build exited ${built.code}: ${firstLine(built.stderr)}` };
    }
    const still = req.missing.filter((name) => !existsSync(join(req.tree, "dist", name)));
    if (still.length > 0) {
      return { ok: false, reason: `the checkout's build produced no ${still.join(", ")}` };
    }
    return { ok: true, built: [...req.missing] };
  };
}

// ----------------------------------------------------------------- the sync

export interface CheckoutSyncOptions {
  home?: string;
  /** The checkout, as a path or as a `path:` selector. */
  dir: string;
  run?: CommandRunner;
  /** Where a released commit's assets come from. Defaults to none. */
  assets?: AssetProvider;
  /** Defaults to the checkout's own `bun run build`. */
  build?: AssetBuilder;
  plugins?: readonly string[];
  platform?: NodeJS.Platform;
  manifestPlatform?: Platform;
  env?: NodeJS.ProcessEnv;
  /** Stage the revision but leave `current` where it is. */
  stageOnly?: boolean;
}

export interface CheckoutSync {
  /**
   * `synced` moved the machine onto the checkout; `current` found it
   * already there, with the staging reused and nothing written;
   * `refused` found something and would not have it.
   */
  outcome: "synced" | "current" | "refused";
  reason: string;
  failure: SetFailure | null;
  identity: CheckoutIdentity | null;
  /** The digest-keyed staging directory, once there is one. */
  staging: string | null;
  /** Asset basenames overlaid from the release published for the commit. */
  reused: string[];
  /** Asset basenames built here, because nothing published them. */
  built: string[];
  /** Whether this sync built or copied anything, as against reusing a staging. */
  staged: boolean;
  active: PackageSetIdentity | null;
  writes: string[];
}

/**
 * Sync one development checkout onto this machine.
 *
 * The order is the same one the online acquisition uses and for the same
 * reason: the cheap question first, and nothing expensive after an
 * answer that ends the run. The identity is read (two `git` calls and
 * one walk), the staging is looked for by that identity's key, and a
 * staging that is already there is reused whole — no copy, no download,
 * no build. Only then is anything assembled.
 */
export async function syncRedSkillsCheckout(opts: CheckoutSyncOptions): Promise<CheckoutSync> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homeOf(env);
  const run = opts.run ?? systemRunner;
  const dir = checkoutPathOf(opts.dir) ?? resolve(opts.dir);

  /**
   * Every ending that is not an activation, in one shape.
   *
   * A refusal writes the one line ADR 0012 has the online acquisition
   * write — the failure and the reason, into the package-set state — so
   * "why is this machine not on the checkout I synced" is answerable by
   * `red-dev doctor` hours later rather than only by the log line that
   * scrolled past. Nothing else writes.
   */
  const nothing = (
    outcome: CheckoutSync["outcome"],
    reason: string,
    failure: SetFailure | null = null,
    extra: Partial<CheckoutSync> = {},
  ): CheckoutSync => ({
    outcome,
    reason,
    failure,
    identity: null,
    staging: null,
    reused: [],
    built: [],
    staged: false,
    active: null,
    writes:
      outcome === "refused" && failure !== null
        ? recordPackageSetRefusal(home, { failure, reason })
        : [],
    ...extra,
  });

  const read = checkoutIdentity(dir, { run });
  if (!read.ok) return nothing("refused", read.reason, "tree");
  const identity = read.identity;

  const plugins =
    opts.plugins ?? redSkillsPluginNames(opts.manifestPlatform ?? manifestPlatformOf(opts.platform));
  const staging = redSkillsCheckoutDir(home, identity.key);

  // The short-cut. A staging keyed by this content is this content:
  // there is nothing to copy, nothing to download and nothing to build,
  // and the converge below writes nothing when `current` already
  // resolves to it.
  const receipt = readCheckoutReceipt(staging);
  const assembled =
    receipt !== null && receipt.key === identity.key
      ? { ok: true as const, reused: receipt.reused, built: receipt.built, staged: false }
      : await assemble({
          home,
          identity,
          staging,
          plugins,
          run,
          ...(opts.assets ? { assets: opts.assets } : {}),
          ...(opts.build ? { build: opts.build } : {}),
        });

  if (!assembled.ok) {
    return nothing("refused", assembled.reason, assembled.failure, { identity, staging });
  }

  // The acceptance criterion, checked rather than asserted: a sync that
  // wrote into the checkout would have changed the very content its
  // identity was computed over, and would be activating a revision that
  // no longer describes anything on this machine.
  const after = checkoutDigest(dir);
  if (after !== identity.content) {
    return nothing(
      "refused",
      `${dir} changed while it was being synced — the checkout must be byte-for-byte unchanged`,
      "tree",
      { identity, staging },
    );
  }

  const converged = convergeRedSkillsPackageSet({
    home,
    checkout: { tree: join(staging, "tree"), identity: checkoutPackageIdentity(identity) },
    ...(opts.platform ? { platform: opts.platform } : {}),
    ...(opts.stageOnly === true ? { stageOnly: true } : {}),
    env,
  });
  if (converged.refused) {
    return nothing("refused", converged.refused.reason, converged.refused.failure, {
      identity,
      staging,
      reused: assembled.reused,
      built: assembled.built,
      staged: assembled.staged,
      active: converged.active,
      writes: converged.writes,
    });
  }

  retainCheckouts(home, converged.retained.map((r) => r.key));

  return {
    outcome: converged.changed ? "synced" : "current",
    reason: converged.changed
      ? `${identity.key} from ${dir}${identity.dirty ? " (dirty)" : ""}`
      : `already on ${identity.key} (${checkoutLabel(dir)})`,
    failure: null,
    identity,
    staging,
    reused: assembled.reused,
    built: assembled.built,
    staged: assembled.staged,
    active: converged.active,
    writes: converged.writes,
  };
}

type Assembly =
  | { ok: true; reused: string[]; built: string[]; staged: true }
  | { ok: false; reason: string; failure: SetFailure };

/**
 * Copy the source, overlay what the commit published, build the rest.
 *
 * Assembled under a `.staging-` name and renamed at the end, so a
 * directory under `checkouts/` either carries a receipt naming its own
 * key or is not a staging at all. An interrupted build can therefore
 * never be reused as a finished one, which is what makes the short-cut
 * above safe to take on nothing but a directory's name.
 */
async function assemble(req: {
  home: string;
  identity: CheckoutIdentity;
  staging: string;
  plugins: readonly string[];
  run: CommandRunner;
  assets?: AssetProvider;
  build?: AssetBuilder;
}): Promise<Assembly> {
  const { identity, staging, plugins } = req;
  const work = redSkillsCheckoutDir(req.home, `.staging-${identity.key}`);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });

  const tree = join(work, "tree");
  cpSync(identity.dir, tree, {
    recursive: true,
    dereference: true,
    filter: (src) => {
      const rel = relative(identity.dir, src);
      return rel === "" || !checkoutExcludes(rel);
    },
  });

  const reused: string[] = [];
  if (identity.sourceCommit !== "" && req.assets) {
    // Clean, at a commit: what that release published describes exactly
    // these bytes. A dirty checkout skips this entirely — its bundles
    // would be the commit's and its source would not.
    const dest = join(work, "assets");
    const outcome = await req.assets({
      commit: identity.sourceCommit,
      version: null,
      tag: null,
      dest,
    });
    if (outcome.kind === "refused") {
      rmSync(work, { recursive: true, force: true });
      const failure: SetFailure = outcome.failure === "network" ? "network" : outcome.failure;
      return { ok: false, reason: outcome.reason, failure };
    }
    if (outcome.kind === "ready") {
      const manifest = parsePackageSetManifest(readFileSync(join(outcome.dir, SET_MANIFEST_NAME)));
      if (!manifest.ok) {
        rmSync(work, { recursive: true, force: true });
        return { ok: false, reason: manifest.reason, failure: "manifest" };
      }
      if (manifest.manifest.sourceCommit !== identity.sourceCommit) {
        rmSync(work, { recursive: true, force: true });
        return {
          ok: false,
          failure: "cross-commit",
          reason:
            `the assets declare commit ${manifest.manifest.sourceCommit.slice(0, 12)} but ` +
            `${identity.dir} is at ${identity.sourceCommit.slice(0, 12)}`,
        };
      }
      const dist = join(tree, "dist");
      mkdirSync(dist, { recursive: true });
      for (const artifact of manifest.manifest.artifacts) {
        if (!overlaysIntoTree(artifact.name)) continue;
        const from = join(setArtifactsDir(outcome.dir), artifact.name);
        if (!existsSync(from)) {
          rmSync(work, { recursive: true, force: true });
          return { ok: false, reason: `declared artifact is missing: ${artifact.name}`, failure: "artifact" };
        }
        cpSync(from, join(dist, artifact.name), { dereference: true });
        reused.push(artifact.name);
      }
    }
  }

  const missing = checkoutAssetGaps(tree, plugins);
  const builder = req.build ?? checkoutAssetBuilder({ run: req.run });
  const built = builder({ tree, missing });
  if (!built.ok) {
    rmSync(work, { recursive: true, force: true });
    return { ok: false, reason: built.reason, failure: "artifact" };
  }

  const gaps = corePayloadGaps(tree);
  if (gaps.length > 0) {
    rmSync(work, { recursive: true, force: true });
    return {
      ok: false,
      reason: `${identity.dir} carries no ${gaps.join(", ")}, so it cannot serve the hosts`,
      failure: "payload",
    };
  }

  // The opt-in gate the host generators read, written beside the tree
  // exactly as a composed set writes it, and never over one the checkout
  // already carries — that file is the developer's to decide.
  const config = join(tree, ".red", "config.yaml");
  if (!existsSync(config)) {
    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, hostActivationConfig(plugins), "utf8");
  }

  const record: CheckoutReceipt = {
    schema: 1,
    key: identity.key,
    content: identity.content,
    commit: identity.commit,
    dirty: identity.dirty,
    reused: [...reused].sort((a, b) => a.localeCompare(b, "en")),
    built: [...built.built].sort((a, b) => a.localeCompare(b, "en")),
  };
  writeFileSync(checkoutReceiptPath(work), `${JSON.stringify(record, null, 2)}\n`, "utf8");

  rmSync(staging, { recursive: true, force: true });
  mkdirSync(dirname(staging), { recursive: true });
  renameSync(work, staging);
  return { ok: true, reused: record.reused, built: record.built, staged: true };
}

/**
 * Drop the staged checkouts no retained revision names.
 *
 * The same retention the revisions have, applied to what they were built
 * from: a directory keyed by content grows with every edit somebody
 * syncs, and a developer edits all day. Nothing is removed when the
 * machine retains no revision at all, which is what an interrupted first
 * sync looks like from here.
 */
export function retainCheckouts(home: string, keep: readonly string[]): string[] {
  const root = redSkillsCheckoutRoot(home);
  if (keep.length === 0 || !existsSync(root)) return [];
  const removed: string[] = [];
  for (const name of listing(root)) {
    if (keep.includes(name) || name.startsWith(".staging-")) continue;
    rmSync(join(root, name), { recursive: true, force: true });
    removed.push(join(root, name));
  }
  return removed;
}

/** The checkout this machine currently resolves, or null. */
export function activeCheckoutKey(home: string): string | null {
  const state = readPackageSetState(home);
  const active = state.revisions.find((r) => r.key === state.active);
  return active && active.kind === "checkout" ? active.key : null;
}

/** One line for each outcome, in the voice the rest of a converge speaks. */
export function announceCheckout(sync: CheckoutSync): void {
  switch (sync.outcome) {
    case "synced": {
      const from =
        sync.reused.length > 0 && sync.built.length > 0
          ? ` (${sync.reused.length} reused, ${sync.built.length} built)`
          : sync.built.length > 0
            ? ` (${sync.built.length} built)`
            : sync.reused.length > 0
              ? ` (${sync.reused.length} reused)`
              : "";
      log.ok(`red-skills checkout: ${sync.reason}${from}`);
      return;
    }
    case "current":
      log.skip(`red-skills checkout: ${sync.reason}`);
      return;
    case "refused":
      log.err(`red-skills checkout refused (${sync.failure ?? "unknown"}): ${sync.reason}`);
      log.plain("       current is unchanged — the machine keeps the set it already resolves");
      return;
  }
}

// ------------------------------------------------------------------ details

function listing(dir: string): string[] {
  try {
    // Sorted, so a retention pass removes in the same order everywhere.
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim() !== "")?.trim() ?? "";
}

/** The same spelling red-skills-set.ts uses, so the two agree on one home. */
function homeOf(env: NodeJS.ProcessEnv): string {
  return (env["HOME"] ?? env["USERPROFILE"] ?? homedir()).replace(/\\/g, "/");
}

/**
 * Enough of a Platform to derive the plugin set, for a caller that was
 * handed nothing but a path.
 */
function manifestPlatformOf(platform?: NodeJS.Platform): Platform {
  const windows = (platform ?? process.platform) === "win32";
  return {
    os: windows ? "windows" : "linux",
    distro: null,
    version: null,
    codename: null,
    env: windows ? "windows" : "desktop",
    arch: process.arch === "arm64" ? "arm64" : "x64",
    caps: { apt: false, gui: false, systemd: false, winget: false, flatpak: false },
  };
}
