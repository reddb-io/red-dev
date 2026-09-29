import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyCacheMaintenance,
  collectPackageCaches,
  inspectCargoBuildCache,
  isCacheMutatingProcess,
  staleStoreDirs,
  type CacheCommandRunner,
} from "./cache-policy.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function result(stdout = "", exitCode = 0) {
  return { stdout, stderr: "", exitCode, timedOut: false, groupGone: true };
}

describe("package cache policy", () => {
  test("recognises cache writers without treating every Bun agent as an installer", () => {
    expect(isCacheMutatingProcess({ comm: "rustc", argv: ["rustc", "lib.rs"] })).toBe(true);
    expect(isCacheMutatingProcess({ comm: "node", argv: ["node", "pnpm.cjs", "install"] })).toBe(true);
    expect(isCacheMutatingProcess({ comm: "bun", argv: ["bun", "run", "agent.ts"] })).toBe(false);
  });

  test("discovers configured roots and assigns only tool-native maintenance", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-cache-home-"));
    roots.push(home);
    for (const path of ["cargo/registry", "cargo/git", "npm", "pnpm-store", "pnpm-cache", "bun"]) {
      mkdirSync(join(home, path), { recursive: true });
      writeFileSync(join(home, path, "derived"), "1234");
    }
    const run: CacheCommandRunner = async (argv) => {
      if (argv[0] === "npm") return result(`${home}/npm\n`);
      if (argv[0] === "pnpm" && argv[1] === "store") return result(`${home}/pnpm-store\n`);
      if (argv[0] === "pnpm" && argv[1] === "cache") return result(`${home}/pnpm-cache\n`);
      if (argv[0] === "bun") return result(`${home}/bun\n`);
      if (argv[0] === "du") return result(`4\t${argv.at(-1)}\n`);
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };

    const caches = await collectPackageCaches({
      env: { HOME: home, CARGO_HOME: `${home}/cargo` },
      run,
    });

    expect(caches.map(({ kind, argv }) => [kind, argv])).toEqual([
      ["cargo-registry", null],
      ["cargo-git", null],
      ["npm", ["npm", "cache", "verify"]],
      ["pnpm", ["pnpm", "store", "prune"]],
      ["pnpm-cache", null],
      ["bun", ["bun", "pm", "cache", "rm"]],
    ]);
    expect(caches.every((cache) => cache.bytes === 4096)).toBe(true);
  });

  test("applies only the official commands and reports measured reduction", async () => {
    const cache = mkdtempSync(join(tmpdir(), "red-pnpm-cache-"));
    roots.push(cache);
    const calls: string[][] = [];
    let measurement = 20;
    const run: CacheCommandRunner = async (argv) => {
      calls.push(argv);
      if (argv[0] === "du") return result(`${measurement}\t${cache}\n`);
      measurement = 4;
      return result("pruned\n");
    };
    const outcomes = await applyCacheMaintenance([
      { kind: "pnpm", path: cache, bytes: 20 * 1024, argv: ["pnpm", "store", "prune"], note: "unreferenced packages" },
      { kind: "cargo-registry", path: "/cargo", bytes: 10, argv: null, note: "Cargo native GC" },
    ], run);

    expect(calls.some((argv) => argv.join(" ") === "pnpm store prune")).toBe(true);
    expect(outcomes).toEqual([{ kind: "pnpm", ok: true, freedBytes: 16 * 1024, detail: "pruned" }]);
  });
});

describe("Cargo build cache policy", () => {
  test("uses Cargo metadata to identify one exact workspace target", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "red-cargo-workspace-"));
    roots.push(workspace);
    const target = join(workspace, "target");
    mkdirSync(target);
    writeFileSync(join(workspace, "Cargo.toml"), "[package]\nname='demo'\nversion='0.1.0'\n");
    writeFileSync(join(target, "CACHEDIR.TAG"), "Signature: 8a477f597d28d172789f06886806bc55\n");
    const run: CacheCommandRunner = async (argv) => {
      if (argv[0] === "cargo") {
        return result(JSON.stringify({ workspace_root: workspace, target_directory: target }));
      }
      if (argv[0] === "du") return result(`1024\t${target}\n`);
      throw new Error(`unexpected command: ${argv.join(" ")}`);
    };

    const cache = await inspectCargoBuildCache(workspace, run);
    expect(cache).toMatchObject({
      kind: "cargo-target",
      path: target,
      bytes: 1024 * 1024,
      argv: ["cargo", "clean", "--manifest-path", join(workspace, "Cargo.toml"), "--target-dir", target],
    });
  });
});

describe("stale package stores", () => {
  test("finds dead pnpm store versions beside the current one, and nothing else", () => {
    const root = mkdtempSync(join(tmpdir(), "red-pnpm-stores-"));
    roots.push(root);
    const store = join(root, "store");
    for (const [name, layout] of [["v3", "files"], ["v10", "index"], ["v11", "files"], ["v2", "unrelated"], ["tmp", "files"]] as const) {
      mkdirSync(join(store, name, layout), { recursive: true });
    }

    expect(staleStoreDirs(join(store, "v11"))).toEqual([join(store, "v10"), join(store, "v3")]);
    // A store that is not laid out like a version directory has no siblings to speak of.
    expect(staleStoreDirs(join(store, "tmp"))).toEqual([]);
  });

  test("offers each dead store and npx's directory as a plain, named deletion", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-cache-stale-"));
    roots.push(home);
    for (const path of ["pnpm/store/v3/files", "pnpm/store/v11/files", "npm/_npx/abc"]) {
      mkdirSync(join(home, path), { recursive: true });
    }
    const run: CacheCommandRunner = async (argv) => {
      if (argv[0] === "npm") return result(`${home}/npm\n`);
      if (argv[0] === "pnpm" && argv[1] === "store") return result(`${home}/pnpm/store/v11\n`);
      if (argv[0] === "du") return result(`8\t${argv.at(-1)}\n`);
      return { ...result("", 1) };
    };

    const caches = await collectPackageCaches({ env: { HOME: home, CARGO_HOME: "" }, run });
    const removals = caches.filter((cache) => cache.argv?.[0] === "rm");

    expect(removals.map(({ kind, argv }) => [kind, argv])).toEqual([
      ["pnpm-store-old", ["rm", "-rf", "--", `${home}/pnpm/store/v3`]],
      ["npm-npx", ["rm", "-rf", "--", `${home}/npm/_npx`]],
    ]);
    // The live store is only ever pruned, never removed.
    expect(caches.find((cache) => cache.kind === "pnpm")?.argv).toEqual(["pnpm", "store", "prune"]);
  });

  test("treats a running npx as a cache writer", () => {
    expect(isCacheMutatingProcess({ comm: "node", argv: ["node", "/x/bin/npx", "cowsay"] })).toBe(true);
  });
});
