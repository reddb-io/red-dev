/**
 * The local plugin: what mise finds on disk, and what it is allowed to
 * be.
 *
 * The scripts are asserted as text rather than executed, because what
 * matters about them is exactly the part a run would hide: that they
 * dispatch into red-dev instead of implementing an acquisition of their
 * own, that they exec so mise reads the phase's real exit code, and that
 * they fail loudly rather than silently when red-dev is not installed.
 * The behaviour behind the dispatch is asserted in
 * red-skills-acquire.test.ts, against the same functions.
 *
 * The fragment is asserted here too, for the half of ADR 0010 that is
 * not code at all: `mise upgrade red-skills` only reaches red-dev's
 * reconciliation if the generated TOML actually declares a postinstall
 * on that entry, and nothing else would notice if it stopped doing so.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureTo } from "./log.ts";
import {
  miseEntries,
  misePluginRoot,
  REDSKILLS_RECONCILE_POSTINSTALL,
  renderMiseConfig,
} from "./mise-config.ts";
import type { Platform } from "./platform.ts";
import {
  convergeRedSkillsMisePlugin,
  isPluginPhase,
  MISE_PLUGIN_NAME,
  pluginFiles,
  pluginScript,
  PLUGIN_PHASES,
  redSkillsMisePluginDir,
} from "./red-skills-mise-plugin.ts";
import { REDSKILLS_CORE_ALIAS, REDSKILLS_CORE_SPEC } from "./red-skills-set.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

function quiet<T>(fn: () => T): T {
  const release = captureTo(() => {});
  try {
    return fn();
  } finally {
    release();
  }
}

describe("where the plugin lives", () => {
  test("beside mise's installs, under whichever data root this machine uses", () => {
    expect(misePluginRoot({ MISE_DATA_DIR: "/data/mise" })).toBe("/data/mise/plugins");
    expect(misePluginRoot({ XDG_DATA_HOME: "/xdg" })).toBe("/xdg/mise/plugins");
    expect(redSkillsMisePluginDir({ MISE_DATA_DIR: "/data/mise" })).toBe(
      join("/data/mise", "plugins", MISE_PLUGIN_NAME),
    );
  });

  test("not under the name the fragment's alias already owns", () => {
    // Two acquisitions behind one word would be an acquisition swap
    // disguised as an install; see the note at the top of the module.
    expect(MISE_PLUGIN_NAME).not.toBe(REDSKILLS_CORE_ALIAS);
    expect(MISE_PLUGIN_NAME.startsWith(REDSKILLS_CORE_ALIAS)).toBe(true);
  });
});

describe("the scripts mise calls", () => {
  test("asdf's names, and the reconcile the postinstall runs", () => {
    expect([...PLUGIN_PHASES]).toEqual(["list-all", "latest-stable", "install", "reconcile"]);
    for (const phase of PLUGIN_PHASES) expect(isPluginPhase(phase)).toBe(true);
    expect(isPluginPhase("download")).toBe(false);
  });

  test("each one dispatches into red-dev rather than acquiring anything itself", () => {
    for (const phase of PLUGIN_PHASES) {
      const script = pluginScript(phase);
      expect(script.startsWith("#!/usr/bin/env bash\n")).toBe(true);
      expect(script).toContain("set -euo pipefail");
      // exec, so the phase's exit code is the script's: a wrapper that
      // swallowed it would report a refused set as an installed one.
      expect(script).toContain(`exec "$red_dev" red-skills ${phase}`);
      // Nothing here clones, archives or verifies. That is the point.
      for (const forbidden of ["git clone", "git archive", "sha256sum", "cosign"]) {
        expect(script, `${phase} must not run ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  test("a machine without red-dev is told so, instead of failing at the first line", () => {
    const script = pluginScript("install");
    expect(script).toContain("$HOME/.local/bin/red-dev");
    expect(script).toContain("RED_DEV_BIN");
    expect(script).toContain("exit 1");
  });

  test("the directory is the four scripts and a note saying who owns it", () => {
    expect(Object.keys(pluginFiles()).sort()).toEqual([
      "README.md",
      "bin/install",
      "bin/latest-stable",
      "bin/list-all",
      "bin/reconcile",
    ]);
    expect(pluginFiles()["README.md"]).toContain("red-dev install");
  });
});

describe("writing it, and then not writing it again", () => {
  test("the scripts land executable, and a second converge writes nothing", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "red-plugin-")), "plugins", MISE_PLUGIN_NAME);

    const first = quiet(() => convergeRedSkillsMisePlugin({ dir }));
    expect(first.changed).toBe(true);
    expect(first.writes).toHaveLength(5);
    for (const phase of PLUGIN_PHASES) {
      const path = join(dir, "bin", phase);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
    }

    const second = quiet(() => convergeRedSkillsMisePlugin({ dir }));
    expect(second.changed).toBe(false);
    expect(second.writes).toEqual([]);
  });

  test("a hand-edited script is put back", () => {
    const dir = join(mkdtempSync(join(tmpdir(), "red-plugin-")), "plugins", MISE_PLUGIN_NAME);
    quiet(() => convergeRedSkillsMisePlugin({ dir }));
    writeFileSync(join(dir, "bin", "install"), "#!/bin/sh\nexit 0\n");

    const again = quiet(() => convergeRedSkillsMisePlugin({ dir }));
    expect(again.writes).toEqual([join(dir, "bin", "install")]);
    expect(readFileSync(join(dir, "bin", "install"), "utf8")).toBe(pluginScript("install"));
  });
});

describe("the fragment tells mise to call red-dev back", () => {
  test("the RedSkills entry carries a postinstall, and only that entry", () => {
    const entries = miseEntries(UBUNTU);
    const core = entries.find((e) => e.spec === REDSKILLS_CORE_SPEC);
    expect(core?.postinstall).toBe(REDSKILLS_RECONCILE_POSTINSTALL);
    for (const other of entries.filter((e) => e.spec !== REDSKILLS_CORE_SPEC)) {
      expect(other.postinstall, other.spec).toBeUndefined();
    }
  });

  test("the postinstall is the command red-dev actually answers to", () => {
    expect(REDSKILLS_RECONCILE_POSTINSTALL).toBe("red-dev red-skills reconcile");
    const phase = REDSKILLS_RECONCILE_POSTINSTALL.split(" ").at(-1) as string;
    expect(isPluginPhase(phase)).toBe(true);
  });

  test("it renders as an inline table, and leaves every other row a plain version", () => {
    const rendered = renderMiseConfig([
      { spec: "github:reddb-io/reddb", alias: "red", version: "latest" },
      {
        spec: REDSKILLS_CORE_SPEC,
        alias: REDSKILLS_CORE_ALIAS,
        version: "latest",
        postinstall: REDSKILLS_RECONCILE_POSTINSTALL,
      },
    ]);
    expect(rendered).toContain(
      `red-skills = { version = "latest", postinstall = "${REDSKILLS_RECONCILE_POSTINSTALL}" }`,
    );
    expect(rendered).toContain('red = "latest"');
  });

  test("the rendering is still deterministic, postinstall and all", () => {
    const entries = miseEntries(UBUNTU);
    expect(renderMiseConfig(entries)).toBe(renderMiseConfig([...entries].reverse()));
  });
});
