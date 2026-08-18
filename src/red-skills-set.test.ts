/**
 * The RedSkills package set: composed from mise, or verified from a
 * published manifest, and the one thing ~/.red-skills/current may name.
 *
 * Everything below runs against a fabricated mise installs tree and a
 * temporary HOME, so it holds on a machine with no mise, no network and
 * no RedSkills. Two things are not faked. Windows is pinned through the
 * function that decides the link flavour rather than by creating a
 * junction — the decision is the part that can regress. And cosign is
 * the real binary: the manifest gates are tested with an injected
 * verifier, but the signature itself is checked by the program the
 * publisher's verifier runs, over the real v3.19.5 bundle with the
 * vendored trust root and no network, and over a fixture signed here
 * with a throwaway key.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { providerFor, TOOLS } from "./manifest.ts";
import { miseEntries, miseToolNames, renderMiseConfig } from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import { activatedPlugins } from "./red-skills-plugins.ts";
import {
  candidateFromMise,
  composeSet,
  CORE_PAYLOAD_CONTRACT,
  corePayloadGaps,
  convergeRedSkillsPackageSet,
  convergeSetAfterMise,
  coreInstallsDir,
  cosignVerifier,
  cosignVerifyArgv,
  createPackageSetManifest,
  directoryLinkType,
  encodePackageSet,
  formatPackageSetIdentity,
  hostActivationConfig,
  installedCoreVersion,
  installedVersions,
  materialiseTrustedRoot,
  miseInstallDirName,
  packageSetDigest,
  packageSetStatePath,
  parsePackageSetManifest,
  payloadDir,
  pluginInstallsDir,
  readPackageSetState,
  redSkillsCurrentLink,
  redSkillsPreviousLink,
  redSkillsSetDir,
  redSkillsSetReport,
  redSkillsSetRows,
  REDSKILLS_CORE_ALIAS,
  REDSKILLS_CORE_SPEC,
  REDSKILLS_RELEASE_IDENTITY,
  REDSKILLS_SET_RETENTION,
  revisionKey,
  SET_BUNDLE_NAME,
  SET_MANIFEST_NAME,
  treeDigest,
  trustedRootPath,
  verifyPackageSet,
  type PackageSetManifest,
  type SignatureVerifier,
} from "./red-skills-set.ts";

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

const PLUGINS = ["dev", "memory", "brain"] as const;
const source = readFileSync(`${import.meta.dir}/red-skills-set.ts`, "utf8");
const FIXTURES = `${import.meta.dir}/fixtures/package-set`;
const VENDORED_ROOT = `${import.meta.dir}/../vendor/sigstore/trusted_root.embedded`;

const accept: SignatureVerifier = () => ({ ok: true, by: "test" });
const reject: SignatureVerifier = () => ({ ok: false, reason: "test refused it" });

/**
 * A mise installs tree carrying the given versions of each tool.
 *
 * Shaped like the real one — `<root>/<tool>/<version>/node_modules/
 * @reddb-io/<package>` — including the selector links mise writes
 * beside the exact versions, since mistaking one of those for a version
 * is the specific way discovery goes wrong. Each package carries just
 * enough of its real shape for the composition and its consumers to be
 * asserted: the core its shims, manifests and opencode-host bundle; a
 * plugin its skills and its bundle (memory also the asset it lazily
 * loads beside the bundle).
 */
function fakeInstalls(
  versions: Partial<Record<"core" | (typeof PLUGINS)[number], string[]>>,
  opts: { selectors?: boolean; content?: Record<string, string>; noBundle?: string[]; legacyCore?: string[] } = {},
): string {
  const root = mkdtempSync(join(tmpdir(), "red-set-installs-"));
  const content = opts.content ?? {};
  for (const version of versions.core ?? []) {
    const payload = payloadDir(coreInstallsDir(root), version, "@reddb-io/red-skills");
    mkdirSync(join(payload, "bin"), { recursive: true });
    mkdirSync(join(payload, ".claude-plugin"), { recursive: true });
    mkdirSync(join(payload, ".agents", "plugins"), { recursive: true });
    mkdirSync(join(payload, "dist"), { recursive: true });
    mkdirSync(join(payload, "scripts"), { recursive: true });
    writeFileSync(
      join(payload, "package.json"),
      `${JSON.stringify({ name: "@reddb-io/red-skills", version })}\n`,
    );
    writeFileSync(join(payload, "bin", "red-skills-redskilled.mjs"), "// redskilled\n");
    writeFileSync(join(payload, "bin", "red-skills-dev.mjs"), "// dev shim\n");
    const marketplace = `${JSON.stringify({ name: "red-skills", plugins: PLUGINS.map((p) => ({ name: p, source: `./plugins/${p}` })) })}\n`;
    writeFileSync(join(payload, ".claude-plugin", "marketplace.json"), marketplace);
    writeFileSync(join(payload, ".agents", "plugins", "marketplace.json"), marketplace);
    writeFileSync(join(payload, "dist", "opencode-host.bundle.min.mjs"), "// opencode-host\n");
    // Mode 0644, exactly as npm unpacks them.
    writeFileSync(join(payload, "scripts", "install-opencode.sh"), "#!/bin/bash\n", { mode: 0o644 });
    writeFileSync(join(payload, "scripts", "install-pi.sh"), "#!/bin/bash\n", { mode: 0o644 });
    // A core from before the package set: bins and dist, nothing a host
    // could register or run — the shape mise resolves while a newer
    // release is still under its minimum release age.
    if ((opts.legacyCore ?? []).includes(version)) {
      rmSync(join(payload, ".claude-plugin"), { recursive: true });
      rmSync(join(payload, ".agents"), { recursive: true });
      rmSync(join(payload, "scripts"), { recursive: true });
    }
  }
  for (const name of PLUGINS) {
    for (const version of versions[name] ?? []) {
      const payload = payloadDir(pluginInstallsDir(root, name), version, `@reddb-io/red-skills-${name}`);
      mkdirSync(join(payload, "skills", `${name}-skill`), { recursive: true });
      mkdirSync(join(payload, "dist"), { recursive: true });
      writeFileSync(
        join(payload, "package.json"),
        `${JSON.stringify({ name: `@reddb-io/red-skills-${name}`, version })}\n`,
      );
      writeFileSync(
        join(payload, "skills", `${name}-skill`, "SKILL.md"),
        content[`${name}:skill`] ?? `# ${name} skill ${version}\n`,
      );
      if (!(opts.noBundle ?? []).includes(name)) {
        writeFileSync(
          join(payload, "dist", `${name}.bundle.min.mjs`),
          content[`${name}:bundle`] ?? `// ${name} bundle ${version}\n`,
        );
      }
      if (name === "memory") {
        writeFileSync(join(payload, "dist", "memory-tokenizer.asset.cjs"), "// tokenizer\n");
      }
    }
  }
  if (opts.selectors !== false) {
    for (const [tool, list] of Object.entries(versions)) {
      if (!list || list.length === 0) continue;
      const dir = tool === "core" ? coreInstallsDir(root) : pluginInstallsDir(root, tool);
      symlinkSync(`./${list[list.length - 1]}`, join(dir, "latest"));
    }
  }
  return root;
}

/** Every tool at the same version(s) — the ordinary, converged case. */
function aligned(versions: string[], opts?: Parameters<typeof fakeInstalls>[1]): string {
  return fakeInstalls({ core: versions, dev: versions, memory: versions, brain: versions }, opts);
}

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "red-set-home-"));
}

function converge(home: string, installsRoot: string, extra: Record<string, unknown> = {}) {
  return convergeRedSkillsPackageSet({
    home,
    installsRoot,
    plugins: PLUGINS,
    platform: "linux",
    ...extra,
  });
}

/**
 * A manifest set on disk: artifacts, the manifest over them, a bundle
 * (real or a placeholder — the verifier is injected), and the tree.
 */
function fakeManifestSet(opts: {
  commit?: string;
  version?: string;
  artifacts?: Record<string, string>;
  bundle?: boolean;
  tree?: boolean;
  mutate?: (manifest: PackageSetManifest, dir: string) => string | void;
} = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "red-set-manifest-"));
  const commit = opts.commit ?? "626a28473edeee992fcf6425dedbca84448343fd";
  const artifacts = opts.artifacts ?? {
    "dev.bundle.min.mjs": "// dev\n",
    "redskilled.bundle.min.mjs": "// redskilled\n",
    "vscode-extension-red-skills-3.19.5.vsix": "vsix bytes\n",
  };
  mkdirSync(join(dir, "artifacts"), { recursive: true });
  const declared = Object.entries(artifacts).map(([name, bytes]) => {
    writeFileSync(join(dir, "artifacts", name), bytes);
    return { name, size: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) };
  });
  const manifest = createPackageSetManifest(commit, declared);
  const text = opts.mutate ? (opts.mutate(manifest, dir) ?? encodePackageSet(manifest)) : encodePackageSet(manifest);
  writeFileSync(join(dir, SET_MANIFEST_NAME), text);
  if (opts.bundle !== false) writeFileSync(join(dir, SET_BUNDLE_NAME), "{}\n");
  if (opts.tree !== false) {
    const tree = join(dir, "tree");
    mkdirSync(join(tree, "plugins", "dev", "skills"), { recursive: true });
    mkdirSync(join(tree, "bin"), { recursive: true });
    writeFileSync(
      join(tree, "package.json"),
      `${JSON.stringify({ name: "@reddb-io/red-skills", version: opts.version ?? "3.19.5" })}\n`,
    );
    writeFileSync(join(tree, "bin", "red-skills-redskilled.mjs"), "// redskilled\n");
    mkdirSync(join(tree, "scripts"), { recursive: true });
    writeFileSync(join(tree, "scripts", "install-opencode.sh"), "#!/bin/bash\n", { mode: 0o644 });
  }
  return dir;
}

/**
 * The cosign binary, wherever this machine keeps it.
 *
 * A mise shim is resolved to the executable behind it while the resolving
 * still works. The signing case below hands cosign a HOME of its own so
 * the throwaway key lands in a temporary directory — and a HOME with no
 * mise config in it is a HOME where the shim answers "cosign is not a
 * valid shim" instead of signing anything. Asking mise now, with the real
 * environment still in place, is the difference between a test that
 * exercises cosign and one that reports the machine as broken.
 */
function findCosign(): string {
  const onPath = Bun.which("cosign");
  if (onPath && !onPath.includes("/mise/shims/")) return onPath;
  const resolved = miseWhich("cosign");
  if (resolved) return resolved;
  if (onPath) return onPath;
  const shim = join(homedir(), ".local", "share", "mise", "shims", "cosign");
  if (existsSync(shim)) return shim;
  throw new Error(
    "cosign is required for these tests: `mise use -g cosign` (it is a core manifest entry, and CI installs it)",
  );
}

/** What mise says a shimmed tool actually is, or null when it cannot say. */
function miseWhich(tool: string): string | null {
  const answer = spawnSync("mise", ["which", tool], { encoding: "utf8" });
  const path = answer.status === 0 ? answer.stdout.trim() : "";
  return path.length > 0 && existsSync(path) ? path : null;
}

// ------------------------------------------------------------- the entries

describe("the manifest entries mise resolves", () => {
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
    const out = renderMiseConfig(miseEntries(UBUNTU));
    expect(out).toContain('red-skills = "npm:@reddb-io/red-skills"');
    expect(out).toContain('red-skills = "latest"');
  });

  test("the projection is byte-identical across runs", () => {
    const once = renderMiseConfig(miseEntries(UBUNTU));
    const twice = renderMiseConfig(miseEntries(UBUNTU));
    const reversed = renderMiseConfig([...miseEntries(UBUNTU)].reverse());
    expect(twice).toBe(once);
    expect(reversed).toBe(once);
  });

  test("`red-dev update` names it, so the version actually moves", () => {
    expect(miseToolNames(UBUNTU)).toContain(REDSKILLS_CORE_ALIAS);
  });

  test("the payload is declared before the row that wires agents to it", () => {
    const names = TOOLS.map((t) => t.name);
    expect(names.indexOf("red-skills-core")).toBeGreaterThan(-1);
    expect(names.indexOf("red-skills-core")).toBeLessThan(names.indexOf("red-skills"));
  });

  test("cosign is a core entry on both targets, and precedes the payload", () => {
    // The verifier has to be on the machine before the first set that
    // needs verifying, and it is the same program the publisher's own
    // verifier runs — spawned, never reimplemented.
    const cosign = TOOLS.find((t) => t.name === "cosign");
    expect(cosign).toBeDefined();
    expect(cosign!.scope).toBe("core");
    for (const p of [UBUNTU, WINDOWS]) {
      expect(providerFor(cosign!, p)).toEqual({ kind: "mise", spec: "cosign" });
    }
    const names = TOOLS.map((t) => t.name);
    expect(names.indexOf("cosign")).toBeLessThan(names.indexOf("red-skills-core"));
  });
});

// ------------------------------------------------------- where mise puts it

describe("where mise puts it", () => {
  test("a tool named through [tool_alias] installs under the alias", () => {
    expect(miseInstallDirName({ spec: REDSKILLS_CORE_SPEC, alias: REDSKILLS_CORE_ALIAS }))
      .toBe("red-skills");
    expect(pluginInstallsDir("/installs", "dev")).toBe("/installs/red-skills-dev");
  });

  test("a bare backend spec is flattened instead", () => {
    expect(miseInstallDirName({ spec: "npm:@types/semver" })).toBe("npm-types-semver");
    expect(miseInstallDirName({ spec: "npm:is-odd" })).toBe("npm-is-odd");
  });

  test("the newest exact version wins, compared as numbers", () => {
    // Lexically, 3.9.0 sorts after 3.10.0 — the ordering bug that only
    // shows up two years after it is written.
    const root = fakeInstalls({ core: ["3.9.0", "3.10.0"] });
    expect(installedCoreVersion(coreInstallsDir(root))).toBe("3.10.0");
    expect(installedVersions(coreInstallsDir(root))).toEqual(["3.9.0", "3.10.0"]);
  });

  test("mise's own selector links are not mistaken for versions", () => {
    const root = fakeInstalls({ core: ["3.10.0"] });
    expect(existsSync(join(coreInstallsDir(root), "latest"))).toBe(true);
    expect(installedVersions(coreInstallsDir(root))).toEqual(["3.10.0"]);
  });

  test("nothing installed is no opinion, not a failure", () => {
    expect(installedCoreVersion(join(tmpdir(), "red-set-absent-xyz"))).toBeNull();
  });
});

// ------------------------------------------------------- the one candidate

describe("the candidate mise offers, read as one set rather than four tools", () => {
  test("every tool at one version is that version", () => {
    const root = aligned(["3.19.5"]);
    const c = candidateFromMise(root, PLUGINS);
    expect(c.kind).toBe("ready");
    if (c.kind !== "ready") return;
    expect(c.version).toBe("3.19.5");
    expect(existsSync(join(c.core, "package.json"))).toBe(true);
    expect(Object.keys(c.plugins)).toEqual([...PLUGINS]);
  });

  test("the highest version present in all of them wins, not each tool's newest", () => {
    // A core published minutes before its plugins is the ordinary case:
    // 3.19.6 is only there for the core, so 3.19.5 is the set.
    const root = fakeInstalls({
      core: ["3.19.5", "3.19.6"],
      dev: ["3.19.5"],
      memory: ["3.19.4", "3.19.5"],
      brain: ["3.19.5"],
    });
    const c = candidateFromMise(root, PLUGINS);
    expect(c.kind).toBe("ready");
    if (c.kind === "ready") expect(c.version).toBe("3.19.5");
  });

  test("every tool present but no version in common is skew, and says which", () => {
    const root = fakeInstalls({ core: ["3.19.6"], dev: ["3.19.5"], memory: ["3.19.5"], brain: ["3.19.5"] });
    const c = candidateFromMise(root, PLUGINS);
    expect(c.kind).toBe("skew");
    if (c.kind === "skew") {
      expect(c.versions["red-skills"]).toEqual(["3.19.6"]);
      expect(c.versions["red-skills-dev"]).toEqual(["3.19.5"]);
    }
  });

  test("a tool not installed yet is incomplete, which is mid-converge rather than a fault", () => {
    const root = fakeInstalls({ core: ["3.19.5"] });
    const c = candidateFromMise(root, PLUGINS);
    expect(c.kind).toBe("incomplete");
    if (c.kind === "incomplete") expect(c.missing).toEqual(["red-skills-dev", "red-skills-memory", "red-skills-brain"]);
  });

  test("a core from before the package set is unusable, and the refusal says what it lacks", () => {
    // What this machine met on 2026-08-18: mise's minimum release age
    // resolved 3.18.12 for all four tools, and that core carries no
    // marketplace manifests and no generators. Composing it produced a
    // tree every host failed against; refusing keeps `current` on the
    // tree that works.
    const root = aligned(["3.18.12"], { legacyCore: ["3.18.12"] });
    const c = candidateFromMise(root, PLUGINS);
    expect(c.kind).toBe("unusable");
    if (c.kind === "unusable") {
      expect(c.reason).toContain("core 3.18.12 carries no .claude-plugin/marketplace.json, .agents/plugins/marketplace.json, scripts/install-opencode.sh, scripts/install-pi.sh");
      expect(c.reason).toContain("minimum release age");
    }
    expect(corePayloadGaps(payloadDir(coreInstallsDir(root), "3.18.12", "@reddb-io/red-skills"))).toEqual(
      CORE_PAYLOAD_CONTRACT.filter((r) => r !== "package.json" && r !== "bin"),
    );
  });

  test("a legacy core beside a complete one does not count, and the complete one wins", () => {
    const root = fakeInstalls(
      { core: ["3.18.12", "3.19.5"], dev: ["3.18.12", "3.19.5"], memory: ["3.18.12", "3.19.5"], brain: ["3.18.12", "3.19.5"] },
      { legacyCore: ["3.18.12"] },
    );
    const c = candidateFromMise(root, PLUGINS);
    expect(c.kind).toBe("ready");
    if (c.kind === "ready") expect(c.version).toBe("3.19.5");
    // And with the plugins only at the legacy version, there is no set
    // — not a broken one.
    const skewed = fakeInstalls(
      { core: ["3.18.12", "3.19.5"], dev: ["3.18.12"], memory: ["3.18.12"], brain: ["3.18.12"] },
      { legacyCore: ["3.18.12"] },
    );
    expect(candidateFromMise(skewed, PLUGINS).kind).toBe("skew");
  });

  test("nothing installed at all is none", () => {
    expect(candidateFromMise(mkdtempSync(join(tmpdir(), "red-set-empty-")), PLUGINS)).toEqual({ kind: "none" });
  });
});

// ------------------------------------------------------------ composition

describe("the composed set", () => {
  test("is the tree the standalone installer produces: core, plugins, bundles, activation config", () => {
    const home = fakeHome();
    const root = aligned(["3.19.5"]);
    const result = converge(home, root);

    expect(result.refused).toBeNull();
    expect(result.active?.version).toBe("3.19.5");
    const current = redSkillsCurrentLink(home);
    const tree = realpathSync(current);
    expect(tree).toBe(realpathSync(result.revisionDir!));
    expect(tree.startsWith(realpathSync(join(home, ".red-skills", "sets")))).toBe(true);

    // The core at the root, as `sourceRoot()` and the shims expect.
    expect(existsSync(join(tree, "package.json"))).toBe(true);
    expect(existsSync(join(tree, "bin", "red-skills-redskilled.mjs"))).toBe(true);
    expect(existsSync(join(tree, ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(existsSync(join(tree, "scripts", "install-opencode.sh"))).toBe(true);
    // Every plugin the marketplace names, where it names it.
    for (const name of PLUGINS) {
      expect(existsSync(join(tree, "plugins", name, "package.json"))).toBe(true);
      expect(existsSync(join(tree, "plugins", name, "skills", `${name}-skill`, "SKILL.md"))).toBe(true);
      // Its bundle beside the core's, where `bin/red-skills-<name>.mjs` resolves it.
      expect(existsSync(join(tree, "dist", `${name}.bundle.min.mjs`))).toBe(true);
    }
    // And the asset the memory bundle lazily loads beside itself.
    expect(existsSync(join(tree, "dist", "memory-tokenizer.asset.cjs"))).toBe(true);
    expect(existsSync(join(tree, "dist", "opencode-host.bundle.min.mjs"))).toBe(true);
    // The activation config the OpenCode generator dies without, naming
    // every payload the set carries and enabling the one Spec #201
    // activates.
    expect(readFileSync(join(tree, ".red", "config.yaml"), "utf8")).toBe(
      hostActivationConfig(PLUGINS, activatedPlugins(PLUGINS)),
    );
    // And the generators runnable: an npm tarball drops the bit, and the
    // host refresh spawns them by path.
    for (const script of ["install-opencode.sh", "install-pi.sh"]) {
      expect(statSync(join(tree, "scripts", script)).mode & 0o111, script).toBe(0o111);
    }
  });

  test("the activation config names every payload and enables only dev", () => {
    // Both halves are load-bearing. Naming a payload the set carries is
    // what makes switching it on later a flag rather than a download;
    // enabling only `dev` is what stops Memory and Brain acting on a
    // machine because they happened to be in the tarball.
    const carried = ["dev", "memory"];
    expect(hostActivationConfig(carried, activatedPlugins(carried))).toContain(
      "plugins:\n  dev:\n    enabled: true\n  memory:\n    enabled: false\n",
    );
    expect(hostActivationConfig(["dev"], ["dev"])).not.toContain("memory");
    expect(activatedPlugins(["dev", "memory", "brain"])).toEqual(["dev"]);
  });

  test("nothing inside the set is a link into mise's tree", () => {
    // A linked bin/ resolves ../dist through its real path and finds
    // the core's dist, never the plugin bundles; a linked dist/ makes
    // the OpenCode generator write into a mise-owned tree; and mise
    // prune would collect what previous points at.
    const home = fakeHome();
    const root = aligned(["3.19.5"]);
    const { revisionDir } = converge(home, root);
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        expect(stat.isSymbolicLink(), path).toBe(false);
        if (stat.isDirectory()) walk(path);
      }
    };
    walk(revisionDir!);
    expect(source).not.toContain("symlinkSync(candidate");
  });

  test("core and plugins at different versions are refused, and current is left where it was", () => {
    // The regression this slice exists for. The old layout linked
    // current at whichever core mise had, plugins or no plugins,
    // versions agreeing or not.
    const home = fakeHome();
    const good = aligned(["3.19.5"]);
    const first = converge(home, good);
    const current = redSkillsCurrentLink(home);
    const before = readlinkSync(current);
    const beforeState = readFileSync(packageSetStatePath(home), "utf8");

    const skewed = fakeInstalls({ core: ["3.19.6"], dev: ["3.19.5"], memory: ["3.19.5"], brain: ["3.19.5"] });
    const result = converge(home, skewed);

    expect(result.refused?.failure).toBe("skew");
    expect(result.refused?.reason).toContain("red-skills 3.19.6");
    expect(result.active).toEqual(first.active);
    expect(readlinkSync(current)).toBe(before);
    expect(existsSync(join(realpathSync(current), "plugins", "dev"))).toBe(true);
    // The refusal is the one thing recorded, so doctor can say why.
    const state = readPackageSetState(home);
    expect(state.refused?.failure).toBe("skew");
    expect(state.active).toBe(first.retained[0]!.key);
    expect(readFileSync(packageSetStatePath(home), "utf8")).not.toBe(beforeState);
    // And a second refusal for the same reason writes nothing more.
    expect(converge(home, skewed).writes).toEqual([]);
  });

  test("a legacy core is refused with current left where the standalone installer put it", () => {
    // The tree install.sh materialised is what the hosts read today;
    // a refused candidate must leave it exactly there, so the
    // registration that runs next still finds a marketplace to register.
    const home = fakeHome();
    const legacy = join(home, ".red-skills", "versions", "v3.19.5");
    mkdirSync(join(legacy, ".claude-plugin"), { recursive: true });
    writeFileSync(join(legacy, "package.json"), "{}\n");
    writeFileSync(join(legacy, ".claude-plugin", "marketplace.json"), "{}\n");
    mkdirSync(join(home, ".red-skills"), { recursive: true });
    symlinkSync(legacy, redSkillsCurrentLink(home));

    const result = converge(home, aligned(["3.18.12"], { legacyCore: ["3.18.12"] }));

    expect(result.refused?.failure).toBe("payload");
    expect(result.active).toBeNull();
    expect(realpathSync(redSkillsCurrentLink(home))).toBe(realpathSync(legacy));
    expect(existsSync(join(realpathSync(redSkillsCurrentLink(home)), ".claude-plugin", "marketplace.json"))).toBe(true);
    expect(existsSync(join(home, ".red-skills", "sets"))).toBe(false);
    const rows = redSkillsSetRows(redSkillsSetReport(home));
    expect(rows.at(-1)!.detail).toStartWith("last candidate refused (payload): core 3.18.12 carries no");
  });

  test("skew on a machine with no set leaves it with no set, and no current", () => {
    const home = fakeHome();
    const skewed = fakeInstalls({ core: ["3.19.6"], dev: ["3.19.5"], memory: ["3.19.5"], brain: ["3.19.5"] });
    const result = converge(home, skewed);
    expect(result.refused?.failure).toBe("skew");
    expect(result.active).toBeNull();
    expect(existsSync(redSkillsCurrentLink(home))).toBe(false);
    expect(existsSync(join(home, ".red-skills", "sets"))).toBe(false);
  });

  test("a runtime plugin whose package carries no bundle is refused before anything is written", () => {
    const home = fakeHome();
    const root = aligned(["3.19.5"], { noBundle: ["dev"] });
    // The package has a dist/ (the memory asset shape) but no bundle: a
    // launcher that would start and find nothing.
    mkdirSync(join(payloadDir(pluginInstallsDir(root, "dev"), "3.19.5", "@reddb-io/red-skills-dev"), "dist"), { recursive: true });
    const result = converge(home, root);
    expect(result.refused?.failure).toBe("artifact");
    expect(result.refused?.reason).toContain("dev");
    expect(existsSync(redSkillsCurrentLink(home))).toBe(false);
    expect(existsSync(join(home, ".red-skills", "sets"))).toBe(false);
  });

  test("a tool not installed yet is waited for, quietly", () => {
    const home = fakeHome();
    const result = converge(home, fakeInstalls({ core: ["3.19.5"] }));
    expect(result.refused).toBeNull();
    expect(result.active).toBeNull();
    expect(result.writes).toEqual([]);
    expect(existsSync(join(home, ".red-skills"))).toBe(false);
  });

  test("mise having installed nothing leaves the machine alone", () => {
    const home = fakeHome();
    const result = converge(home, mkdtempSync(join(tmpdir(), "red-set-empty-")));
    expect(result.writes).toEqual([]);
    expect(existsSync(join(home, ".red-skills"))).toBe(false);
  });

  test("an existing revision directory is reused, never recomposed", () => {
    const home = fakeHome();
    const root = aligned(["3.19.5"]);
    const first = converge(home, root);
    const marker = join(first.revisionDir!, "dist", "opencode", "generated.txt");
    mkdirSync(join(first.revisionDir!, "dist", "opencode"), { recursive: true });
    writeFileSync(marker, "the OpenCode generator wrote this into the tree");
    // A generator's derived output does not change what the set *is*.
    const again = converge(home, root);
    expect(again.writes).toEqual([]);
    expect(existsSync(marker)).toBe(true);
    // Only the composed identity is what names it — the marker is not
    // part of the payload, and the key did not move.
    expect(again.active).toEqual(first.active);
  });

  test("the layout step ignores every tool that is not RedSkills, and fires for every one that is", () => {
    const home = fakeHome();
    const root = aligned(["3.19.5"]);
    expect(convergeSetAfterMise("github:reddb-io/reddb", { home, installsRoot: root, plugins: PLUGINS, platform: "linux" })).toBeNull();
    expect(existsSync(join(home, ".red-skills"))).toBe(false);
    for (const spec of ["npm:@reddb-io/red-skills-dev", "npm:@reddb-io/red-skills"]) {
      const result = convergeSetAfterMise(spec, { home, installsRoot: root, plugins: PLUGINS, platform: "linux" });
      expect(result, spec).not.toBeNull();
      expect(result!.active?.version).toBe("3.19.5");
    }
  });
});

// --------------------------------------------------------------- identity

describe("the identity", () => {
  test("is version plus a digest of the whole tree, and the same inputs name the same set", () => {
    const a = converge(fakeHome(), aligned(["3.19.5"]));
    const b = converge(fakeHome(), aligned(["3.19.5"]));
    expect(a.active).toEqual(b.active);
    expect(revisionKey(a.active!)).toMatch(/^3\.19\.5\+[0-9a-f]{12}$/);
    expect(a.active!.sourceCommit).toBe("");
    expect(formatPackageSetIdentity(a.active!)).toBe(revisionKey(a.active!));
  });

  test("changing one plugin file changes it", () => {
    const base = converge(fakeHome(), aligned(["3.19.5"])).active!;
    const skill = converge(fakeHome(), aligned(["3.19.5"], { content: { "dev:skill": "# a different skill\n" } })).active!;
    expect(skill.digest).not.toBe(base.digest);
    expect(skill.version).toBe(base.version);
  });

  test("changing one companion artifact changes it", () => {
    const base = converge(fakeHome(), aligned(["3.19.5"])).active!;
    const bundle = converge(fakeHome(), aligned(["3.19.5"], { content: { "brain:bundle": "// rebuilt\n" } })).active!;
    expect(bundle.digest).not.toBe(base.digest);
  });

  test("a published set's identity is the manifest's own digest and commit", () => {
    const home = fakeHome();
    const set = fakeManifestSet();
    const result = converge(home, "unused", { source: set, verifier: accept });
    const manifest = JSON.parse(readFileSync(join(set, SET_MANIFEST_NAME), "utf8")) as PackageSetManifest;
    expect(result.active).toEqual({
      version: "3.19.5",
      digest: manifest.wholeSetDigest,
      sourceCommit: manifest.sourceCommit,
    });
    expect(formatPackageSetIdentity(result.active!)).toBe(`3.19.5+${manifest.wholeSetDigest.slice(0, 12)}@626a284`);
  });

  test("changing an artifact, or the source commit, changes a published set's identity", () => {
    const one = createPackageSetManifest("a".repeat(40), [{ name: "x", size: 1, sha256: "0".repeat(64) }]);
    const artifact = createPackageSetManifest("a".repeat(40), [{ name: "x", size: 1, sha256: "1".repeat(64) }]);
    const commit = createPackageSetManifest("b".repeat(40), [{ name: "x", size: 1, sha256: "0".repeat(64) }]);
    const added = createPackageSetManifest("a".repeat(40), [
      { name: "x", size: 1, sha256: "0".repeat(64) },
      { name: "y", size: 1, sha256: "0".repeat(64) },
    ]);
    const digests = new Set([one, artifact, commit, added].map((m) => m.wholeSetDigest));
    expect(digests.size).toBe(4);
    expect(createPackageSetManifest("a".repeat(40), [{ name: "x", size: 1, sha256: "0".repeat(64) }]).wholeSetDigest)
      .toBe(one.wholeSetDigest);
  });

  test("the tree digest is order-independent and content-sensitive", () => {
    const a = mkdtempSync(join(tmpdir(), "red-set-tree-"));
    mkdirSync(join(a, "b"), { recursive: true });
    writeFileSync(join(a, "b", "two"), "2");
    writeFileSync(join(a, "one"), "1");
    const b = mkdtempSync(join(tmpdir(), "red-set-tree-"));
    writeFileSync(join(b, "one"), "1");
    mkdirSync(join(b, "b"), { recursive: true });
    writeFileSync(join(b, "b", "two"), "2");
    expect(treeDigest(a)).toBe(treeDigest(b));
    writeFileSync(join(b, "b", "two"), "3");
    expect(treeDigest(a)).not.toBe(treeDigest(b));
  });
});

// ------------------------------------------------------ the published set

describe("the published manifest, exactly as red-skills writes it", () => {
  const golden = readFileSync(`${FIXTURES}/v3.19.5.manifest.json`);

  test("the real v3.19.5 manifest parses, and its digest recomputes", () => {
    const parsed = parsePackageSetManifest(golden);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.manifest.sourceCommit).toBe("626a28473edeee992fcf6425dedbca84448343fd");
    expect(parsed.manifest.wholeSetDigest).toBe("3fcba9589ff057b5fdc92c96f2f04c81f15a9c6c54b6497770bdc656aabe48c3");
    expect(packageSetDigest(parsed.manifest)).toBe(parsed.manifest.wholeSetDigest);
    expect(encodePackageSet(parsed.manifest)).toBe(golden.toString("utf8"));
    expect(parsed.manifest.artifacts.map((a) => a.name)).toContain("verify-package-set.mjs");
  });

  const cases: [string, (m: PackageSetManifest) => string][] = [
    ["not JSON", () => "{"],
    ["a different key order", (m) => `${JSON.stringify({ sourceCommit: m.sourceCommit, schema: m.schema, artifacts: m.artifacts, wholeSetDigest: m.wholeSetDigest }, null, 2)}\n`],
    ["an unknown schema, which is how incompatible target metadata arrives", (m) => encodePackageSet({ ...m, schema: "red.package-set.v2" })],
    ["a targets field the publisher does not emit", (m) => `${JSON.stringify({ ...m, targets: ["linux-x64"] }, null, 2)}\n`],
    ["an unsorted artifact list", (m) => encodePackageSet({ ...m, artifacts: [...m.artifacts].reverse() })],
    ["a duplicate artifact", (m) => encodePackageSet({ ...m, artifacts: [m.artifacts[0]!, m.artifacts[0]!] })],
    ["an artifact from another commit", (m) => encodePackageSet({ ...m, artifacts: [{ ...m.artifacts[0]!, sourceCommit: "f".repeat(40) }, ...m.artifacts.slice(1)] })],
    ["a digest that does not describe the contents", (m) => encodePackageSet({ ...m, wholeSetDigest: "0".repeat(64) })],
    ["non-canonical bytes", (m) => JSON.stringify(m)],
    ["a path where a basename belongs", (m) => encodePackageSet({ ...m, artifacts: [{ ...m.artifacts[0]!, name: "../x" }, ...m.artifacts.slice(1)] })],
  ];
  for (const [what, mutate] of cases) {
    test(`is refused with ${what}`, () => {
      const parsed = parsePackageSetManifest(golden);
      if (!parsed.ok) throw new Error("golden did not parse");
      const outcome = parsePackageSetManifest(mutate(parsed.manifest));
      expect(outcome.ok, what).toBe(false);
    });
  }
});

describe("verifying a published set", () => {
  test("a valid set verifies, in the order the gates run", () => {
    const set = fakeManifestSet();
    const calls: string[] = [];
    const verifier: SignatureVerifier = (m, b) => {
      calls.push(m, b);
      return { ok: true, by: "test" };
    };
    const result = verifyPackageSet(set, { verifier });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.trust).toEqual({ kind: "trusted", by: "test" });
    expect(result.tree).toBe(join(set, "tree"));
    expect(calls).toEqual([join(set, SET_MANIFEST_NAME), join(set, SET_BUNDLE_NAME)]);
  });

  test("a missing manifest is absent, not broken", () => {
    const dir = mkdtempSync(join(tmpdir(), "red-set-none-"));
    expect(verifyPackageSet(dir, { verifier: accept })).toEqual({
      ok: false,
      failure: "absent",
      reason: `${SET_MANIFEST_NAME} is not there`,
    });
  });

  test("an artifact whose bytes differ, or that is missing, fails before the signature is asked", () => {
    const set = fakeManifestSet();
    writeFileSync(join(set, "artifacts", "dev.bundle.min.mjs"), "// dev tampered\n");
    let asked = false;
    const spy: SignatureVerifier = () => {
      asked = true;
      return { ok: true, by: "test" };
    };
    const tampered = verifyPackageSet(set, { verifier: spy });
    expect(tampered).toEqual({ ok: false, failure: "artifact", reason: "artifact size mismatch: dev.bundle.min.mjs" });
    expect(asked).toBe(false);

    const same = fakeManifestSet();
    writeFileSync(join(same, "artifacts", "dev.bundle.min.mjs"), "// dvv\n");
    expect(verifyPackageSet(same, { verifier: accept })).toEqual({
      ok: false,
      failure: "artifact",
      reason: "artifact checksum mismatch: dev.bundle.min.mjs",
    });

    const missing = fakeManifestSet();
    cpSync(join(missing, "artifacts", "dev.bundle.min.mjs"), join(missing, "moved"));
    writeFileSync(join(missing, "artifacts", "dev.bundle.min.mjs"), "");
    expect(verifyPackageSet(missing, { verifier: accept }).ok).toBe(false);
  });

  test("a bundle that is missing, or does not verify, is refused as a signature failure", () => {
    expect(verifyPackageSet(fakeManifestSet({ bundle: false }), { verifier: accept })).toEqual({
      ok: false,
      failure: "signature",
      reason: `${SET_BUNDLE_NAME} is missing`,
    });
    expect(verifyPackageSet(fakeManifestSet(), { verifier: reject })).toEqual({
      ok: false,
      failure: "signature",
      reason: "test refused it",
    });
  });

  test("a set with nothing to activate is refused", () => {
    expect(verifyPackageSet(fakeManifestSet({ tree: false }), { verifier: accept })).toEqual({
      ok: false,
      failure: "tree",
      reason: "the set carries no workstation tree with a package.json",
    });
  });
});

// ---------------------------------------------------------- the activation

describe("activating a published set", () => {
  test("copies the tree under its identity, moves current, and records trusted", () => {
    const home = fakeHome();
    const set = fakeManifestSet();
    const result = converge(home, "unused", { source: set, verifier: accept });
    expect(result.refused).toBeNull();
    const current = redSkillsCurrentLink(home);
    expect(realpathSync(current)).toBe(realpathSync(result.revisionDir!));
    expect(result.revisionDir).toBe(redSkillsSetDir(home, revisionKey(result.active!)));
    expect(existsSync(join(result.revisionDir!, "plugins", "dev", "skills"))).toBe(true);
    expect(statSync(join(result.revisionDir!, "scripts", "install-opencode.sh")).mode & 0o111).toBe(0o111);
    expect(readPackageSetState(home).revisions[0]).toMatchObject({ kind: "manifest", trust: "trusted" });
    // A copy into machine-owned storage: the set directory could be a
    // USB stick, and nothing on the machine may keep pointing at it.
    expect(realpathSync(current).startsWith(realpathSync(set))).toBe(false);
  });

  const refusals: [string, () => string, SignatureVerifier][] = [
    ["an unknown schema", () => fakeManifestSet({ mutate: (m) => encodePackageSet({ ...m, schema: "red.package-set.v2" }) }), accept],
    ["a tampered artifact", () => { const s = fakeManifestSet(); writeFileSync(join(s, "artifacts", "dev.bundle.min.mjs"), "x"); return s; }, accept],
    ["a missing bundle", () => fakeManifestSet({ bundle: false }), accept],
    ["a signature that does not verify", () => fakeManifestSet(), reject],
  ];
  for (const [what, make, verifier] of refusals) {
    test(`with ${what}, current is left exactly where it was`, () => {
      const home = fakeHome();
      const good = converge(home, aligned(["3.19.4"]));
      const current = redSkillsCurrentLink(home);
      const link = readlinkSync(current);
      const ino = lstatSync(current).ino;

      const result = converge(home, "unused", { source: make(), verifier });

      expect(result.refused, what).not.toBeNull();
      expect(result.active).toEqual(good.active);
      expect(readlinkSync(current)).toBe(link);
      expect(lstatSync(current).ino).toBe(ino);
      expect(readdirSync(join(home, ".red-skills", "sets")).filter((n) => !n.startsWith("."))).toEqual([good.retained[0]!.key]);
    });
  }

  test("a machine that resolves a verified set never accepts an unsigned one again", () => {
    const home = fakeHome();
    const trusted = converge(home, "unused", { source: fakeManifestSet(), verifier: accept });
    const result = converge(home, aligned(["3.19.6"]));
    expect(result.refused?.failure).toBe("downgrade");
    expect(result.active).toEqual(trusted.active);
    expect(realpathSync(redSkillsCurrentLink(home))).toBe(realpathSync(trusted.revisionDir!));
  });

  test("staging verifies and copies, and leaves current alone until asked", () => {
    const home = fakeHome();
    const before = converge(home, aligned(["3.19.4"]));
    const staged = converge(home, "unused", { source: fakeManifestSet(), verifier: accept, stageOnly: true });
    expect(staged.refused).toBeNull();
    expect(staged.active).toEqual(before.active);
    expect(staged.writes.length).toBe(1);
    expect(existsSync(staged.writes[0]!)).toBe(true);
    expect(realpathSync(redSkillsCurrentLink(home))).toBe(realpathSync(before.revisionDir!));
    // Activating it afterwards is the ordinary path, and finds the copy already there.
    const activated = converge(home, "unused", { source: fakeManifestSet(), verifier: accept });
    expect(activated.writes).not.toContain(staged.writes[0]);
    expect(realpathSync(redSkillsCurrentLink(home))).toBe(realpathSync(staged.writes[0]!));
  });
});

// ------------------------------------------------ rollback and idempotency

describe("rollback and a converge that has nothing to do", () => {
  test("a newer set moves current, previous names the one it replaced, and both are addressable", () => {
    const home = fakeHome();
    const v1 = converge(home, aligned(["3.19.4"]));
    const v2 = converge(home, aligned(["3.19.5"]));
    expect(realpathSync(redSkillsCurrentLink(home))).toBe(realpathSync(v2.revisionDir!));
    expect(realpathSync(redSkillsPreviousLink(home))).toBe(realpathSync(v1.revisionDir!));
    expect(existsSync(join(v1.revisionDir!, "package.json"))).toBe(true);
    expect(existsSync(join(v2.revisionDir!, "package.json"))).toBe(true);
    const state = readPackageSetState(home);
    expect(state.active).toBe(v2.retained[0]!.key);
    expect(state.revisions.map((r) => r.version)).toEqual(["3.19.5", "3.19.4"]);
  });

  test("a second converge writes nothing: not the pointer, not the state, not a byte", () => {
    const home = fakeHome();
    const root = aligned(["3.19.5"]);
    converge(home, root);
    const current = redSkillsCurrentLink(home);
    const ino = lstatSync(current).ino;
    const state = readFileSync(packageSetStatePath(home), "utf8");
    const stateMtime = statSync(packageSetStatePath(home)).mtimeMs;

    const again = converge(home, root);

    expect(again.changed).toBe(false);
    expect(again.writes).toEqual([]);
    expect(lstatSync(current).ino).toBe(ino);
    expect(readFileSync(packageSetStatePath(home), "utf8")).toBe(state);
    expect(statSync(packageSetStatePath(home)).mtimeMs).toBe(stateMtime);
  });

  test(`a third set retires the oldest: ${REDSKILLS_SET_RETENTION} revisions, and mise's payloads untouched`, () => {
    const home = fakeHome();
    const roots = [aligned(["3.19.3"]), aligned(["3.19.4"]), aligned(["3.19.5"])];
    const [v1, v2, v3] = roots.map((root) => converge(home, root));
    expect(existsSync(v1!.revisionDir!)).toBe(false);
    expect(existsSync(v2!.revisionDir!)).toBe(true);
    expect(existsSync(v3!.revisionDir!)).toBe(true);
    expect(v3!.writes).toContain(v1!.revisionDir!);
    expect(readPackageSetState(home).revisions.length).toBe(REDSKILLS_SET_RETENTION);
    expect(realpathSync(redSkillsPreviousLink(home))).toBe(realpathSync(v2!.revisionDir!));
    for (const root of roots) {
      // The source trees are mise's to collect, and every one is still there.
      expect(existsSync(payloadDir(coreInstallsDir(root), installedCoreVersion(coreInstallsDir(root))!, "@reddb-io/red-skills"))).toBe(true);
    }
  });

  test("with nothing to roll back to, a stale previous is removed", () => {
    const home = fakeHome();
    mkdirSync(join(home, ".red-skills"), { recursive: true });
    symlinkSync(join(home, "nowhere"), redSkillsPreviousLink(home));
    converge(home, aligned(["3.19.5"]));
    expect(existsSync(redSkillsPreviousLink(home))).toBe(false);
    expect(lstatSync(redSkillsPreviousLink(home), { throwIfNoEntry: false })).toBeUndefined();
  });

  test("a dangling link the old layout left under versions/ is cleaned up, a real tree there is not", () => {
    const home = fakeHome();
    const versions = join(home, ".red-skills", "versions");
    mkdirSync(join(versions, "v3.18.12"), { recursive: true });
    writeFileSync(join(versions, "v3.18.12", "package.json"), "{}\n");
    symlinkSync(join(home, "pruned-mise-tree"), join(versions, "v3.19.0"));
    converge(home, aligned(["3.19.5"]));
    expect(existsSync(join(versions, "v3.18.12", "package.json"))).toBe(true);
    expect(lstatSync(join(versions, "v3.19.0"), { throwIfNoEntry: false })).toBeUndefined();
  });
});

// ------------------------------------------------------------ the Windows link

describe("the Windows link", () => {
  test("is a junction, which needs no developer mode", () => {
    expect(directoryLinkType("win32")).toBe("junction");
  });

  test("every other platform gets a plain directory symlink", () => {
    expect(directoryLinkType("linux")).toBe("dir");
    expect(directoryLinkType("darwin")).toBe("dir");
  });

  test("current and previous are the only links, and are created with that flavour", () => {
    expect(source).toContain("symlinkSync(target, path, directoryLinkType(platform))");
    expect(source).toContain("symlinkSync(target, staging, directoryLinkType(platform))");
    expect(source.match(/symlinkSync\(/g)?.length).toBe(2);
  });

  test("a real directory in the way is left alone rather than deleted", () => {
    const home = fakeHome();
    const current = redSkillsCurrentLink(home);
    mkdirSync(current, { recursive: true });
    writeFileSync(join(current, "mine.txt"), "keep");
    const result = converge(home, aligned(["3.19.5"]));
    expect(result.revisionDir).toBeNull();
    expect(existsSync(join(current, "mine.txt"))).toBe(true);
    expect(lstatSync(current).isSymbolicLink()).toBe(false);
  });
});

// ------------------------------------------- the consumers that resolve through current

describe("the consumers that resolve through current", () => {
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

  test("the layout is still readable through the link, and resolves past it", async () => {
    const home = fakeHome();
    const result = converge(home, aligned(["3.19.5"]));
    const { resolvedSource, sourceRoot } = await import("./red-skills-ext.ts");
    await withHome(home, () => {
      expect(sourceRoot()).toBe(`${home}/.red-skills/current`);
      expect(resolvedSource()).toBe(realpathSync(result.revisionDir!));
    });
  });

  test("the host census still finds the resident client", async () => {
    const home = fakeHome();
    converge(home, aligned(["3.19.5"]));
    const { resolveRedskilledBin } = await import("./host-state.ts");
    expect(resolveRedskilledBin(home)).toBe(`${home}/.red-skills/current/bin/red-skills-redskilled.mjs`);
  });

  test("the WSL rescue shim looks in both places too", () => {
    const hostState = readFileSync(`${import.meta.dir}/host-state.ts`, "utf8");
    expect(hostState).toContain(".red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs");
    expect(hostState).toContain(".red-skills/current/bin/red-skills-redskilled.mjs");
  });
});

// ------------------------------------------------------------- the report

describe("what doctor says", () => {
  const scrub = (home: string, value: unknown): unknown =>
    JSON.parse(JSON.stringify(value).replaceAll(home, "<home>").replace(/[0-9a-f]{64}/g, "<digest>").replace(/\+[0-9a-f]{12}/g, "+<digest12>"));

  test("no set: one line, and no rollback", () => {
    const home = fakeHome();
    expect(redSkillsSetReport(home)).toEqual({ active: null, retained: [], refused: null });
    expect(redSkillsSetRows(redSkillsSetReport(home))).toEqual([
      { status: "n/a", detail: "no RedSkills package set is active on this machine" },
    ]);
  });

  test("a composed set: unsigned, and the JSON a script would read", () => {
    const home = fakeHome();
    converge(home, aligned(["3.19.4"]));
    converge(home, aligned(["3.19.5"]));
    expect(scrub(home, redSkillsSetReport(home))).toEqual({
      active: {
        version: "3.19.5",
        digest: "<digest>",
        sourceCommit: "",
        kind: "composed",
        trust: "unsigned",
        path: "<home>/.red-skills/sets/3.19.5+<digest12>",
      },
      retained: [
        { key: "3.19.5+<digest12>", version: "3.19.5", digest: "<digest>", sourceCommit: "", kind: "composed", trust: "unsigned", path: "<home>/.red-skills/sets/3.19.5+<digest12>", addressable: true },
        { key: "3.19.4+<digest12>", version: "3.19.4", digest: "<digest>", sourceCommit: "", kind: "composed", trust: "unsigned", path: "<home>/.red-skills/sets/3.19.4+<digest12>", addressable: true },
      ],
      refused: null,
    });
    const rows = redSkillsSetRows(redSkillsSetReport(home));
    expect(rows[0]!.status).toBe("warn");
    expect(rows[0]!.detail).toMatch(/^3\.19\.5\+[0-9a-f]{12} — composed from mise, unsigned/);
    expect(rows[1]!.status).toBe("ok");
    expect(rows[1]!.detail).toMatch(/^rollback available: 3\.19\.4\+[0-9a-f]{12}$/);
  });

  test("a verified set: trusted, with its commit", () => {
    const home = fakeHome();
    converge(home, "unused", { source: fakeManifestSet(), verifier: accept });
    const report = redSkillsSetReport(home);
    expect(report.active).toMatchObject({ kind: "manifest", trust: "trusted", sourceCommit: "626a28473edeee992fcf6425dedbca84448343fd" });
    const rows = redSkillsSetRows(report);
    expect(rows[0]).toEqual({
      status: "ok",
      detail: `${formatPackageSetIdentity(report.active!)} — published set, signature verified over the declared artifacts`,
    });
    expect(rows[1]).toEqual({ status: "n/a", detail: "no previous revision to roll back to yet" });
  });

  test("a refused candidate is reported beside whatever is active", () => {
    const home = fakeHome();
    converge(home, aligned(["3.19.5"]));
    converge(home, fakeInstalls({ core: ["3.19.6"], dev: ["3.19.5"], memory: ["3.19.5"], brain: ["3.19.5"] }));
    const report = redSkillsSetReport(home);
    expect(report.refused?.failure).toBe("skew");
    const rows = redSkillsSetRows(report);
    expect(rows.at(-1)!.status).toBe("err");
    expect(rows.at(-1)!.detail).toStartWith("last candidate refused (skew): no version is installed for every RedSkills tool");
  });

  test("a rollback revision that is gone is said to be gone", () => {
    const home = fakeHome();
    const v1 = converge(home, aligned(["3.19.4"]));
    converge(home, aligned(["3.19.5"]));
    // Somebody deleted it by hand.
    spawnSync("rm", ["-rf", v1.revisionDir!]);
    const rows = redSkillsSetRows(redSkillsSetReport(home));
    expect(rows[1]!.status).toBe("warn");
    expect(rows[1]!.detail).toContain("is recorded but gone");
  });
});

// ------------------------------------------------------------------ cosign

describe("cosign, the verifier every real machine uses", () => {
  test("the keyless argv pins the release identity, the issuer, and the trust root", () => {
    expect(cosignVerifyArgv("/s/m.json", "/s/b.json", {
      cosignBin: "cosign",
      identityRegexp: REDSKILLS_RELEASE_IDENTITY,
      issuer: "https://token.actions.githubusercontent.com",
      trustedRoot: "/root.json",
    })).toEqual([
      "cosign", "verify-blob", "--offline",
      "--bundle", "/s/b.json",
      "--certificate-identity-regexp", REDSKILLS_RELEASE_IDENTITY,
      "--certificate-oidc-issuer", "https://token.actions.githubusercontent.com",
      "--trusted-root", "/root.json",
      "/s/m.json",
    ]);
    // Verbatim from the verifier the release ships — cross-checked
    // against the sibling checkout where there is one (a maintainer's
    // machine), and pinned here for everywhere else.
    expect(REDSKILLS_RELEASE_IDENTITY).toBe(
      "^https://github\\.com/reddb-io/red-skills/\\.github/workflows/red-publish\\.yml@refs/heads/main$" +
        "|^https://github\\.com/reddb-io/red-skills/\\.github/workflows/red-publish\\.yml@refs/tags/v[0-9]+\\.[0-9]+\\.[0-9]+$",
    );
    const sibling = `${import.meta.dir}/../../red-skills/scripts/verify-package-set.mjs`;
    if (existsSync(sibling)) {
      const match = /const RELEASE_IDENTITY =\s*("[^"]*")\s*\+\s*("[^"]*");/.exec(readFileSync(sibling, "utf8"));
      expect(match).not.toBeNull();
      expect(REDSKILLS_RELEASE_IDENTITY).toBe(JSON.parse(match![1]!) + JSON.parse(match![2]!));
    }
  });

  test("the vendored trust root is written out once, and rewritten only when it changes", () => {
    const home = fakeHome();
    const path = materialiseTrustedRoot(home);
    expect(path).toBe(trustedRootPath(home));
    expect(readFileSync(path).equals(readFileSync(VENDORED_ROOT))).toBe(true);
    const mtime = statSync(path).mtimeMs;
    materialiseTrustedRoot(home);
    expect(statSync(path).mtimeMs).toBe(mtime);
    const lock = JSON.parse(readFileSync(`${import.meta.dir}/../vendor/sigstore/sigstore.lock.json`, "utf8")) as { sha256: string };
    expect(sha256Hex(readFileSync(VENDORED_ROOT))).toBe(lock.sha256);
  });

  test("the real v3.19.5 bundle verifies against the vendored root, with no network", () => {
    const cosign = findCosign();
    const home = fakeHome();
    const set = mkdtempSync(join(tmpdir(), "red-set-real-"));
    cpSync(`${FIXTURES}/v3.19.5.manifest.json`, join(set, SET_MANIFEST_NAME));
    cpSync(`${FIXTURES}/v3.19.5.manifest.sigstore.json`, join(set, SET_BUNDLE_NAME));
    const verifier = cosignVerifier({ cosignBin: cosign, home });
    const verdict = verifier(join(set, SET_MANIFEST_NAME), join(set, SET_BUNDLE_NAME));
    expect(verdict).toEqual({ ok: true, by: "red-skills release workflow (sigstore)" });
    // Whereas one byte more and it is not that manifest any more.
    writeFileSync(join(set, SET_MANIFEST_NAME), `${readFileSync(join(set, SET_MANIFEST_NAME), "utf8")}\n`);
    const tampered = verifier(join(set, SET_MANIFEST_NAME), join(set, SET_BUNDLE_NAME));
    expect(tampered.ok).toBe(false);
    if (!tampered.ok) expect(tampered.reason).toStartWith("manifest signature is invalid");
  });

  test("a set signed here with a throwaway key installs, and its tampered twin is refused", () => {
    const cosign = findCosign();
    const keys = mkdtempSync(join(tmpdir(), "red-set-keys-"));
    const env = { ...process.env, COSIGN_PASSWORD: "", HOME: keys };
    const gen = spawnSync(cosign, ["generate-key-pair"], { cwd: keys, env, encoding: "utf8" });
    expect(gen.status, gen.stderr).toBe(0);

    const sign = (dir: string): void => {
      const manifest = join(dir, SET_MANIFEST_NAME);
      const bundle = join(dir, SET_BUNDLE_NAME);
      const base = [ "sign-blob", "--key", join(keys, "cosign.key"), "--bundle", bundle, "--tlog-upload=false", "-y", manifest ];
      // cosign 3 routes signing through a signing config unless told
      // not to; cosign 2 does not know the flag.
      let out = spawnSync(cosign, [...base.slice(0, -1), "--use-signing-config=false", manifest], { env, encoding: "utf8" });
      if (out.status !== 0) out = spawnSync(cosign, base, { env, encoding: "utf8" });
      expect(out.status, out.stderr).toBe(0);
    };
    const keyVerifier: SignatureVerifier = (manifest, bundle) => {
      const out = spawnSync(cosign, ["verify-blob", "--key", join(keys, "cosign.pub"), "--bundle", bundle, "--insecure-ignore-tlog", manifest], { env, encoding: "utf8" });
      return out.status === 0 ? { ok: true, by: "throwaway key" } : { ok: false, reason: `manifest signature is invalid: ${out.stderr.trim().split("\n").pop()}` };
    };

    const good = fakeManifestSet({ bundle: false });
    sign(good);
    const home = fakeHome();
    const installed = converge(home, "unused", { source: good, verifier: keyVerifier });
    expect(installed.refused).toBeNull();
    expect(readPackageSetState(home).revisions[0]!.trust).toBe("trusted");

    // Same artifacts, same tree, one byte in the manifest after signing.
    const twin = fakeManifestSet({ bundle: false });
    sign(twin);
    writeFileSync(join(twin, SET_MANIFEST_NAME), `${readFileSync(join(twin, SET_MANIFEST_NAME), "utf8")} `);
    const result = converge(fakeHome(), "unused", { source: twin, verifier: keyVerifier });
    expect(result.refused?.failure).toBe("manifest");

    // And a manifest re-encoded canonically after being re-signed by nobody.
    const unsigned = fakeManifestSet({ bundle: false, artifacts: { "dev.bundle.min.mjs": "// other\n" } });
    cpSync(join(good, SET_BUNDLE_NAME), join(unsigned, SET_BUNDLE_NAME));
    const stolen = converge(fakeHome(), "unused", { source: unsigned, verifier: keyVerifier });
    expect(stolen.refused?.failure).toBe("signature");
  });
});

// ------------------------------------------------- the converge path that runs it

describe("the converge path that runs the layout step", () => {
  const providers = readFileSync(`${import.meta.dir}/providers.ts`, "utf8");

  test("a mise install is followed by the set converge, for the core and for every plugin", () => {
    expect(providers).toContain("convergeSetAfterMise(pr.spec");
    expect(source).toContain("spec.startsWith(REDSKILLS_PLUGIN_PREFIX)");
  });

  test("the suite install and the suite upgrade reach it as well", () => {
    const suite = providers.slice(providers.indexOf("export async function miseInstallSuite"));
    expect(suite.slice(0, suite.indexOf("\n}"))).toContain("linkRedSkillsCore(platform)");
    const upgrade = providers.slice(providers.indexOf("export async function miseUpgradeSuite"));
    expect(upgrade.slice(0, upgrade.indexOf("\n}"))).toContain("linkRedSkillsCore(platform)");
    expect(providers).toContain("convergeRedSkillsPackageSet(");
  });

  test("the retired module is gone, and nothing imports it", () => {
    expect(existsSync(`${import.meta.dir}/red-skills-core.ts`)).toBe(false);
    for (const name of readdirSync(import.meta.dir)) {
      if (!name.endsWith(".ts") || name === "red-skills-set.test.ts") continue;
      const text = readFileSync(join(import.meta.dir, name), "utf8");
      expect(text, name).not.toContain('from "./red-skills-core.ts"');
    }
  });

  test("composeSet is exercised through the same helper the converge uses", () => {
    // Belt and braces for the composition contract on its own.
    const root = aligned(["3.19.5"]);
    const c = candidateFromMise(root, PLUGINS);
    if (c.kind !== "ready") throw new Error(c.kind);
    const dest = join(mkdtempSync(join(tmpdir(), "red-set-compose-")), "out");
    expect(composeSet(c, dest)).toEqual({ ok: true });
    chmodSync(join(dest, "scripts", "install-opencode.sh"), 0o755);
    expect(readdirSync(join(dest, "plugins")).sort()).toEqual([...PLUGINS].sort());
  });
});
