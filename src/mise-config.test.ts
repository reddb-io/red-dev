/**
 * The generated mise fragment, and the two properties it has to hold.
 *
 * It must be *valid* — a malformed TOML here disables every tool in the
 * file at once, and mise reports it as a config error rather than as a
 * missing tool, which points the reader at the wrong thing entirely.
 *
 * It must be *stable* — the file is rewritten on every converge and
 * compared against disk to decide whether anything happened. Rendering
 * that depends on manifest order, or on object key order, turns every
 * converge into a change and every change into a log line saying
 * something was done when nothing was.
 *
 * Both are checked against the pure renderer rather than by running
 * mise, so they hold on a machine with no mise, no network and no
 * reddb-io release published yet.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  miseConfigPath,
  miseEntries,
  miseInstallRoot,
  miseToolBin,
  renderMiseConfig,
  type MiseEntry,
} from "./mise-config.ts";
import { providerFor, TOOLS } from "./manifest.ts";
import type { Platform } from "./platform.ts";

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

describe("renderMiseConfig", () => {
  test("an aliased tool is declared once as an alias and once as a version", () => {
    const out = renderMiseConfig([
      { spec: "github:reddb-io/reddb", alias: "red", version: "1.23.2" },
    ]);
    expect(out).toContain('[tool_alias]\nred = "github:reddb-io/reddb"');
    expect(out).toContain('[tools]\nred = "1.23.2"');
  });

  test("output does not depend on the order entries arrive in", () => {
    const a: MiseEntry[] = [
      { spec: "github:reddb-io/toon", alias: "tq", version: "0.28.2" },
      { spec: "github:reddb-io/reddb", alias: "red", version: "1.23.2" },
      { spec: "npm:@reddb-io/red-skills", version: "3.18.12" },
    ];
    expect(renderMiseConfig(a)).toBe(renderMiseConfig([...a].reverse()));
  });

  test("rendering the same entries twice is byte-identical", () => {
    const e: MiseEntry[] = [{ spec: "github:reddb-io/dit", alias: "dit", version: "latest" }];
    expect(renderMiseConfig(e)).toBe(renderMiseConfig(e));
  });

  test("a spec that is not a bare TOML key is quoted", () => {
    // Unquoted, `npm:@reddb-io/red-skills = "..."` is a parse error and
    // takes the whole file down with it.
    const out = renderMiseConfig([{ spec: "npm:@reddb-io/red-skills", version: "3.18.12" }]);
    expect(out).toContain('"npm:@reddb-io/red-skills" = "3.18.12"');
  });

  test("no entries still yields a parseable file rather than an empty one", () => {
    const out = renderMiseConfig([]);
    expect(out.startsWith("#")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
  });

  test("it says it is generated, because it is overwritten without asking", () => {
    expect(renderMiseConfig([])).toContain("Do not edit");
  });
});

describe("miseEntries", () => {
  test("every mise provider in the manifest reaches the fragment", () => {
    const declared = TOOLS.filter((t) => providerFor(t, UBUNTU).kind === "mise");
    expect(miseEntries(UBUNTU)).toHaveLength(declared.length);
  });

  test("the suite CLIs are there, under the names people type", () => {
    const aliases = miseEntries(UBUNTU).map((e) => e.alias);
    expect(aliases).toContain("red");
    expect(aliases).toContain("tq");
  });

  test("a platform's entries are its own — dit is a mise tool only on Windows", () => {
    // On Linux dit needs the uinput group and udev rule its installer
    // writes, so it stays on the vendor script. A regression there is
    // silent: the binary installs and simply never types.
    const linux = miseEntries(UBUNTU).map((e) => e.spec);
    const windows = miseEntries(WINDOWS).map((e) => e.spec);
    expect(linux).not.toContain("github:reddb-io/dit");
    expect(windows).toContain("github:reddb-io/dit");
  });

  test("no entry is missing a version selector", () => {
    for (const e of miseEntries(UBUNTU)) expect(e.version.length).toBeGreaterThan(0);
  });
});

describe("the uninstall sweep", () => {
  test("names the fragment, because red-dev generated it", () => {
    // It is headed "Do not edit" and lists tools that are about to stop
    // existing; leaving it behind would have `mise upgrade` reinstall a
    // suite the machine no longer has.
    const source = readFileSync("src/uninstall.ts", "utf8");
    expect(source).toContain("conf.d/10-reddb-io.toml");
  });

  test("still never removes the user's own mise config", () => {
    // Asserted against the removal targets rather than the whole file:
    // the prose above them names config.toml precisely to say it is
    // left alone, and a search over the source cannot tell a promise
    // from a path.
    const source = readFileSync("src/uninstall.ts", "utf8");
    const from = source.indexOf("const targets = [");
    const paths = source
      .slice(from, source.indexOf("];", from))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("`"));
    expect(paths.join("\n")).toContain("conf.d/10-reddb-io.toml");
    expect(paths.join("\n")).not.toContain("mise/config.toml");
  });
});

describe("miseConfigPath", () => {
  test("it is a conf.d fragment, never the user's own config", () => {
    const path = miseConfigPath("/home/someone");
    // Writing config.toml would take the user's runtimes with it.
    expect(path).toBe("/home/someone/.config/mise/conf.d/10-reddb-io.toml");
  });
});

describe("the binary of a mise-installed tool", () => {
  function installs(): string {
    const root = mkdtempSync(join(tmpdir(), "mise-tool-bin-"));
    mkdirSync(join(root, "installs"), { recursive: true });
    return root;
  }

  function tool(root: string, name: string, version: string, rel: string[]): string {
    const path = join(root, "installs", name, version, ...rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "#!/bin/sh\n");
    return path;
  }

  test("is null when mise has never installed it, so the caller falls back to the name", () => {
    expect(miseToolBin("cosign", "cosign", { MISE_DATA_DIR: installs() })).toBeNull();
  });

  test("follows `latest`, which is what an upgrade moves", () => {
    const root = installs();
    tool(root, "cosign", "3.1.3", ["cosign"]);
    const latest = tool(root, "cosign", "latest", ["cosign"]);
    expect(miseToolBin("cosign", "cosign", { MISE_DATA_DIR: root })).toBe(latest);
  });

  test("takes the newest real version when nothing is linked, numerically", () => {
    const root = installs();
    tool(root, "cosign", "3.9.0", ["cosign"]);
    const newest = tool(root, "cosign", "3.10.0", ["cosign"]);
    expect(miseToolBin("cosign", "cosign", { MISE_DATA_DIR: root })).toBe(newest);
  });

  test("looks inside bin/ too, which is where most tools land", () => {
    const root = installs();
    const nested = tool(root, "node", "24.18.0", ["bin", "node"]);
    expect(miseToolBin("node", "node", { MISE_DATA_DIR: root })).toBe(nested);
  });

  test("resolves through the same data root the rest of this module does", () => {
    const root = installs();
    const path = tool(root, "cosign", "3.1.3", ["cosign"]);
    expect(path.startsWith(miseInstallRoot({ MISE_DATA_DIR: root }))).toBe(true);
  });
});
