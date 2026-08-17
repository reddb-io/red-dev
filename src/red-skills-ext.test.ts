/**
 * The two RedSkills artifacts, installed from what CI already published.
 *
 * Both used to be built here, out of ~/.red-skills/current, which meant a
 * pnpm install of a 19-package workspace to produce a `.vsix` the release
 * already carried. The published package stopped carrying monorepo
 * source, so that build is now impossible as well as wasteful.
 *
 * What these cover is the converge as a machine experiences it: which
 * release was asked for, which commands ran, what survives a GitHub that
 * does not answer, and what an uninstall takes back.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  EXTENSION_ID,
  HERDR_BUNDLE_ASSET,
  HERDR_PLUGIN_SOURCE,
  LEGACY_EXTENSION_ID,
  REDSKILLS_REPO,
  VSIX_ASSET,
  assetCache,
  installHerdrPlugin,
  installVscodeExtension,
  readRecord,
  refreshRedSkillsExtensions,
  uninstallHerdrPlugin,
  uninstallVscodeExtension,
  type ExtIo,
} from "./red-skills-ext.ts";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { GhRelease } from "./providers.ts";

const savedHome = process.env["HOME"];

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
});

function platform(over: Partial<Platform> = {}): Platform {
  return {
    os: "linux", distro: "ubuntu", version: "24.04", codename: "noble",
    env: "wsl", arch: "x64",
    caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
    ...over,
  } as Platform;
}

/** A machine with nothing on it but a HOME. No red-skills checkout. */
function bareMachine(): string {
  const root = mkdtempSync(`${tmpdir()}/red-skills-ext-`);
  process.env["HOME"] = root;
  return root;
}

function release(tag: string, file: string): GhRelease {
  return {
    tag,
    file,
    url: `https://github.com/${REDSKILLS_REPO}/releases/download/${tag}/${file}`,
    checksumUrl: null,
  };
}

interface Recorder extends ExtIo {
  /** Every command the converge ran, in order. */
  commands: string[][];
  /** Every asset glob it asked GitHub for. */
  asked: string[];
  /** Every asset it fetched. */
  downloaded: string[];
}

/** An io that answers from memory and remembers what it was asked. */
function fakeIo(over: Partial<ExtIo> & { tag?: string } = {}): Recorder {
  const tag = over.tag ?? "v3.18.12";
  const commands: string[][] = [];
  const asked: string[] = [];
  const downloaded: string[] = [];

  const io: Recorder = {
    commands,
    asked,
    downloaded,
    clis: () => ["code"],
    editorsWithExtension: async () => ["code"],
    hasHerdr: () => true,
    herdrHasPlugin: async () => true,
    async resolve(glob: string) {
      asked.push(glob);
      const file =
        glob === VSIX_ASSET ? `vscode-extension-red-skills-${tag.replace(/^v/, "")}.vsix` : glob;
      return release(tag, file);
    },
    async download(rel: GhRelease) {
      downloaded.push(rel.file);
      const dir = assetCache();
      mkdirSync(dir, { recursive: true });
      const dest = `${dir}/${rel.file}`;
      writeFileSync(dest, "vsix");
      return dest;
    },
    async run(cmd: string[]) {
      commands.push(cmd);
      return 0;
    },
    ...over,
  };
  return io;
}

describe("the manifest still offers both", () => {
  const vscode = TOOLS.find((t) => t.name === "red-skills-vscode");
  const herdr = TOOLS.find((t) => t.name === "red-skills-herdr");

  test("are in the optional scope", () => {
    expect(vscode?.scope).toBe("optional");
    expect(herdr?.scope).toBe("optional");
  });

  test("herdr's is skipped on Windows, which has no stable herdr", () => {
    expect(providerFor(herdr!, platform({ os: "windows", env: "windows" })).kind).toBe("skip");
  });

  test("neither still advertises a build", () => {
    // The note was the operator's warning that choosing this cost a pnpm
    // install of a turbo workspace. There is no build left to warn about.
    expect(vscode?.about).not.toContain("pnpm");
    expect(vscode?.about).not.toContain("source");
  });
});

describe("the extension comes from the release", () => {
  test("resolves the published .vsix and installs it, with nothing built", async () => {
    bareMachine();
    const io = fakeIo();
    await installVscodeExtension(io);

    expect(io.asked).toEqual([VSIX_ASSET]);
    expect(io.downloaded).toEqual(["vscode-extension-red-skills-3.18.12.vsix"]);
    expect(io.commands).toHaveLength(1);
    expect(io.commands[0]?.slice(0, 2)).toEqual(["code", "--install-extension"]);
    expect(io.commands[0]?.at(-1)).toBe("--force");

    // Nothing was built, and nothing looked for a checkout to build in.
    const ran = io.commands.flat();
    expect(ran).not.toContain("pnpm");
    expect(ran).not.toContain("build");
    expect(ran).not.toContain("package");
  });

  test("a machine with no source tree installs it anyway", async () => {
    const root = bareMachine();
    // Nothing here — the published artifact no longer carries the tree
    // this used to be built from, so this is the ordinary machine now.
    expect(existsSync(`${root}/.red-skills`)).toBe(false);

    const io = fakeIo();
    await installVscodeExtension(io);
    expect(readRecord().vscode).toEqual({ tag: "v3.18.12", editors: ["code"], id: EXTENSION_ID });
  });

  test("goes into every editor found, and records only the ones that took it", async () => {
    bareMachine();
    const io = fakeIo({
      clis: () => ["code", "codium", "cursor"],
      async run(cmd: string[]) {
        io.commands.push(cmd);
        return cmd[0] === "codium" ? 1 : 0;
      },
    });
    await installVscodeExtension(io);
    expect(readRecord().vscode?.editors).toEqual(["code", "cursor"]);
  });

  test("nothing is recorded when no editor took it", async () => {
    bareMachine();
    const io = fakeIo({ run: async () => 1 });
    await installVscodeExtension(io);
    expect(readRecord().vscode).toBeUndefined();
  });

  test("no editor on the machine means no download at all", async () => {
    bareMachine();
    const io = fakeIo({ clis: () => [] });
    await installVscodeExtension(io);
    expect(io.asked).toEqual([]);
    expect(io.downloaded).toEqual([]);
  });
});

describe("the herdr plugin comes from the release", () => {
  test("pins the install to the tag the published bundle came from", async () => {
    bareMachine();
    const io = fakeIo();
    await installHerdrPlugin(platform(), io);

    // The bundle asset is what proves the release published a plugin at
    // all; the tag is what the install is held to. Unpinned, herdr reads
    // the default branch, whose manifest can name a bundle no release has.
    expect(io.asked).toEqual([HERDR_BUNDLE_ASSET]);
    expect(io.commands[0]).toEqual([
      "herdr", "plugin", "install", HERDR_PLUGIN_SOURCE, "--ref", "v3.18.12", "--yes",
    ]);
    expect(readRecord().herdr).toEqual({ tag: "v3.18.12" });
  });

  test("a machine with no source tree installs it anyway", async () => {
    const root = bareMachine();
    expect(existsSync(`${root}/.red-skills`)).toBe(false);

    const io = fakeIo();
    await installHerdrPlugin(platform(), io);
    expect(readRecord().herdr?.tag).toBe("v3.18.12");
    // The old fallback prepared the workspace and linked the checkout.
    const ran = io.commands.flat();
    expect(ran).not.toContain("pnpm");
    expect(ran).not.toContain("link");
  });

  test("no herdr means nothing is asked of GitHub", async () => {
    bareMachine();
    const io = fakeIo({ hasHerdr: () => false });
    await installHerdrPlugin(platform(), io);
    expect(io.asked).toEqual([]);
    expect(io.commands).toEqual([]);
  });

  test("a herdr that refuses the install records nothing and does not throw", async () => {
    bareMachine();
    const io = fakeIo({ run: async () => 1 });
    await installHerdrPlugin(platform(), io);
    expect(readRecord().herdr).toBeUndefined();
  });
});

describe("a release that cannot be resolved", () => {
  /** GitHub rate-limited, offline, or a release with no such asset. */
  function unresolvable(): Partial<ExtIo> {
    return {
      resolve: async (glob: string) => {
        throw new Error(`no asset matching '${glob}' in latest ${REDSKILLS_REPO} release`);
      },
    };
  }

  test("is reported and leaves the extension alone rather than throwing", async () => {
    bareMachine();
    const io = fakeIo(unresolvable());
    // Not `rejects`: a converge that stops here abandons the dotfiles,
    // themes and agents that come after it.
    await installVscodeExtension(io);
    expect(io.commands).toEqual([]);
    expect(readRecord()).toEqual({});
  });

  test("is reported and leaves the herdr plugin alone rather than throwing", async () => {
    bareMachine();
    const io = fakeIo(unresolvable());
    await installHerdrPlugin(platform(), io);
    expect(io.commands).toEqual([]);
    expect(readRecord()).toEqual({});
  });

  test("a failed download is the same kind of failure", async () => {
    bareMachine();
    const io = fakeIo({
      download: async () => {
        throw new Error("download failed 503");
      },
    });
    await installVscodeExtension(io);
    expect(io.commands).toEqual([]);
    expect(readRecord()).toEqual({});
  });

  test("one artifact failing does not stop the other", async () => {
    bareMachine();
    const io = fakeIo({
      async resolve(glob: string) {
        io.asked.push(glob);
        if (glob === VSIX_ASSET) throw new Error("GitHub API 403 — rate limited");
        return release("v3.18.12", glob);
      },
    });
    await refreshRedSkillsExtensions(platform(), io);
    expect(io.asked).toEqual([VSIX_ASSET, HERDR_BUNDLE_ASSET]);
    expect(readRecord().vscode).toBeUndefined();
    expect(readRecord().herdr?.tag).toBe("v3.18.12");
  });
});

describe("refresh advances against the release, not a checkout", () => {
  test("does nothing when the recorded tag is the published one", async () => {
    bareMachine();
    const io = fakeIo();
    await installVscodeExtension(io);
    await installHerdrPlugin(platform(), io);

    const after = fakeIo();
    await refreshRedSkillsExtensions(platform(), after);
    expect(after.downloaded).toEqual([]);
    expect(after.commands).toEqual([]);
  });

  test("reinstalls both when the release moved", async () => {
    bareMachine();
    const io = fakeIo();
    await installVscodeExtension(io);
    await installHerdrPlugin(platform(), io);

    const moved = fakeIo({ tag: "v3.19.0" });
    await refreshRedSkillsExtensions(platform(), moved);
    expect(moved.downloaded).toEqual(["vscode-extension-red-skills-3.19.0.vsix"]);
    expect(moved.commands.map((c) => c[0])).toEqual(["code", "herdr"]);
    expect(readRecord().vscode?.tag).toBe("v3.19.0");
    expect(readRecord().herdr?.tag).toBe("v3.19.0");
  });

  test("a machine with neither installed is left alone", async () => {
    bareMachine();
    const io = fakeIo({
      editorsWithExtension: async () => [],
      herdrHasPlugin: async () => false,
    });
    await refreshRedSkillsExtensions(platform(), io);
    // Absence is a choice. `update` must not advance a machine into
    // software it never asked for.
    expect(io.asked).toEqual([]);
    expect(io.commands).toEqual([]);
  });

  test("an editor carrying the pre-rename extension still counts as installed", async () => {
    // The app was renamed, so a machine converged before it carries
    // `vscode-redskilled`. A probe that knew only the new id would report
    // every such machine as not having it and leave it behind forever.
    expect(LEGACY_EXTENSION_ID).not.toBe(EXTENSION_ID);
    bareMachine();
    const io = fakeIo();
    await refreshRedSkillsExtensions(platform(), io);
    expect(io.downloaded).toEqual(["vscode-extension-red-skills-3.18.12.vsix"]);
  });
});

describe("uninstall takes back what this path installed", () => {
  test("removes the extension from the editors that took it, and the cached asset", async () => {
    bareMachine();
    const io = fakeIo({ clis: () => ["code", "cursor"] });
    await installVscodeExtension(io);
    expect(existsSync(assetCache())).toBe(true);

    const undo = fakeIo();
    const removed = await uninstallVscodeExtension(undo);
    expect(undo.commands).toEqual([
      ["code", "--uninstall-extension", EXTENSION_ID],
      ["cursor", "--uninstall-extension", EXTENSION_ID],
    ]);
    expect(removed).toHaveLength(2);
    expect(existsSync(assetCache())).toBe(false);
    expect(readRecord().vscode).toBeUndefined();
  });

  test("removes the herdr plugin and the binding red-dev generated", async () => {
    bareMachine();
    const io = fakeIo();
    await installHerdrPlugin(platform(), io);

    const { herdrConfigPath } = await import("./herdr.ts");
    const config = herdrConfigPath(platform()) as string;
    expect(readFileSync(config, "utf8")).toContain("prefix+d");

    const undo = fakeIo();
    const removed = await uninstallHerdrPlugin(platform(), undo);
    expect(undo.commands[0]).toEqual(["herdr", "plugin", "uninstall", "reddb-io.red-skills"]);
    expect(removed).toContain("reddb-io.red-skills");
    expect(readFileSync(config, "utf8")).not.toContain("prefix+d");
    expect(readRecord().herdr).toBeUndefined();
  });

  test("removes nothing on a machine this path never touched", async () => {
    bareMachine();
    const io = fakeIo();
    expect(await uninstallVscodeExtension(io)).toEqual([]);
    expect(await uninstallHerdrPlugin(platform(), io)).toEqual([]);
    expect(io.commands).toEqual([]);
  });

  test("removes the extension under the id it was installed as", async () => {
    // A machine converged before the rename has the old identifier in
    // its editors; removing the new one would leave the old in place and
    // report success.
    const root = bareMachine();
    mkdirSync(`${root}/.local/share/red-dev`, { recursive: true });
    writeFileSync(
      `${root}/.local/share/red-dev/red-skills-extensions.json`,
      JSON.stringify({ vscode: { tag: "v3.3.0", editors: ["code"], id: LEGACY_EXTENSION_ID } }),
    );

    const io = fakeIo();
    await uninstallVscodeExtension(io);
    expect(io.commands).toEqual([["code", "--uninstall-extension", LEGACY_EXTENSION_ID]]);
  });

  test("the uninstall offer follows the record, not the machine", async () => {
    bareMachine();
    const { redSkillsExtensionRemovals } = await import("./uninstall.ts");
    // Nothing installed by red-dev: an extension somebody added by hand
    // is not this project's to take away.
    expect(redSkillsExtensionRemovals(platform())).toEqual([]);

    await installVscodeExtension(fakeIo());
    await installHerdrPlugin(platform(), fakeIo());
    expect(redSkillsExtensionRemovals(platform()).map((r) => r.tool.name)).toEqual([
      "red-skills-vscode",
      "red-skills-herdr",
    ]);
  });
});
