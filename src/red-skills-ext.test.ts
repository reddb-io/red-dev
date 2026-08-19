/**
 * What is left to prove once the release path is gone.
 *
 * The extension and the herdr plugin are installed from the package set
 * now (src/red-skills-companions.test.ts covers that), so what this file
 * holds is the other half of ADR 0014: a machine converged *before* it
 * carries `red-skills-extensions.json`, and everything that record
 * justifies has to keep working — the offer it makes, the identifier it
 * names, the herdr binding that goes with the plugin, and the rule that a
 * machine with no record has nothing taken off it.
 *
 * The record is written directly here rather than produced by an install,
 * because there is no longer an install that writes it. That is the state
 * under test: a file left behind by a version of red-dev this one has to
 * be able to clean up after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  assetCache,
  EXTENSION_ID,
  LEGACY_EXTENSION_ID,
  readRecord,
  uninstallHerdrPlugin,
  uninstallVscodeExtension,
  writeRecord,
  type ExtIo,
} from "./red-skills-ext.ts";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";

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

/** A machine with nothing on it but a HOME. */
function bareMachine(): string {
  const root = mkdtempSync(`${tmpdir()}/red-skills-ext-`);
  process.env["HOME"] = root;
  return root;
}

interface Recorder extends ExtIo {
  /** Every command the uninstall ran, in order. */
  commands: string[][];
}

/** An io that answers from memory and remembers what it was asked. */
function fakeIo(code: (cmd: string[]) => number = () => 0): Recorder {
  const commands: string[][] = [];
  return {
    commands,
    async run(cmd: string[]) {
      commands.push(cmd);
      return code(cmd);
    },
  };
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

describe("nothing here resolves a release any more", () => {
  test("the module exports no asset, repo or installer to resolve one with", async () => {
    // ADR 0014's whole point, asserted on the surface rather than on a
    // call: an install path that is still exported is one something can
    // still reach for.
    const ext = (await import("./red-skills-ext.ts")) as Record<string, unknown>;
    for (const gone of [
      "installVscodeExtension",
      "installHerdrPlugin",
      "refreshRedSkillsExtensions",
      "VSIX_ASSET",
      "HERDR_BUNDLE_ASSET",
      "HERDR_PLUGIN_SOURCE",
      "REDSKILLS_REPO",
    ]) {
      expect(ext[gone], gone).toBeUndefined();
    }
  });
});

describe("uninstall takes back what the old path installed", () => {
  test("removes the extension from the editors that took it, and the cached asset", async () => {
    bareMachine();
    mkdirSync(assetCache(), { recursive: true });
    writeFileSync(`${assetCache()}/vscode-extension-red-skills-3.18.12.vsix`, "vsix");
    await writeRecord({ vscode: { tag: "v3.18.12", editors: ["code", "cursor"], id: EXTENSION_ID } });

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
    await writeRecord({ herdr: { tag: "v3.18.12" } });
    const { bindHerdrDashboard, herdrConfigPath } = await import("./herdr.ts");
    await bindHerdrDashboard(platform());

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
    bareMachine();
    await writeRecord({ vscode: { tag: "v3.3.0", editors: ["code"], id: LEGACY_EXTENSION_ID } });

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

    await writeRecord({ vscode: { tag: "v3.18.12", editors: ["code"], id: EXTENSION_ID } });
    await writeRecord({ herdr: { tag: "v3.18.12" } });
    expect(redSkillsExtensionRemovals(platform()).map((r) => r.tool.name)).toEqual([
      "red-skills-vscode",
      "red-skills-herdr",
    ]);
  });
});
