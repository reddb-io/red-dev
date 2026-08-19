/**
 * The handover from release downloads to mise, and the two places it
 * would have failed silently.
 *
 * Moving a tool's provider is the easy half. The hard half is that a
 * converge asks `installState` whether the tool is there and
 * `installState` asks PATH — so on every machine already carrying the
 * binary an older release put in ~/.local/bin, the answer is yes, the
 * new provider never runs, and the move delivers nothing while
 * reporting success. Measured before this existed: tq 0.26.2 on PATH
 * with 0.28.2 released.
 *
 * The second is narrower and just as quiet: mise puts its shims
 * somewhere PATH does not reach unless something says so, so a tool
 * could install correctly and be invisible to the very run that
 * installed it, and to every non-interactive shell afterwards.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { providerFor, TOOLS } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { miseEntries, miseToolNames } from "./mise-config.ts";
import { staleReleaseBinaries } from "./migrations.ts";
import { runtimeBinDir } from "./red-skills-companions.ts";
import { locateTool } from "./verify-install.ts";

const ubuntu: Platform = {
  os: "linux",
  env: "desktop",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "red-dev-mise-handover-"));
  roots.push(dir);
  return dir;
}

function withEnv<T>(vars: Record<string, string>, fn: () => T): T {
  const before = new Map(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of before) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  }
}

describe("the stale binary an older release left behind", () => {
  test("is found, so the migration knows the machine needs it", () => {
    const home = temp();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "tq"), "#!/bin/sh\nexit 0\n");

    withEnv({ HOME: home }, () => {
      const stale = staleReleaseBinaries(ubuntu);
      expect(stale.map((s) => s.name)).toContain("tq");
      expect(stale.find((s) => s.name === "tq")?.path).toBe(join(home, ".local", "bin", "tq"));
    });
  });

  test("is nothing at all on a machine that never had one", () => {
    const home = temp();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    withEnv({ HOME: home }, () => {
      expect(staleReleaseBinaries(ubuntu)).toEqual([]);
    });
  });

  test("is only ever looked for in ~/.local/bin", () => {
    // carapace's old Linux column was a .deb, so its leftover sits in
    // /usr/bin owned by dpkg. Removing another package manager's file
    // is not a repair, and the shim ahead of it on PATH is the answer.
    const home = temp();
    mkdirSync(join(home, "usr", "bin"), { recursive: true });
    writeFileSync(join(home, "usr", "bin", "carapace"), "#!/bin/sh\nexit 0\n");
    withEnv({ HOME: home }, () => {
      expect(staleReleaseBinaries(ubuntu)).toEqual([]);
    });
  });

  test("names the tool the way mise was told about it, not the way the file is spelled", () => {
    // `mise which` is what proves the replacement exists before the
    // original goes, and it answers to the alias — `tq`, never
    // `github:reddb-io/toon`.
    const home = temp();
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    writeFileSync(join(home, ".local", "bin", "red"), "#!/bin/sh\nexit 0\n");
    withEnv({ HOME: home }, () => {
      expect(staleReleaseBinaries(ubuntu).map((s) => s.name)).toEqual(["red"]);
    });
  });
});

describe("mise's shims", () => {
  const path = readFileSync("config/bash/path.sh", "utf8");

  test("are on PATH, so a tool works outside an activated shell", () => {
    // `mise activate` covers interactive bash and nothing else. A
    // script, a systemd unit and `ssh host 'tq ...'` all get the shims
    // or they get nothing.
    expect(path).toContain("/shims");
    expect(path).toContain("MISE_DATA_DIR");
  });

  test("win over a binary an older release left in ~/.local/bin", () => {
    // _red_path_prepend puts each entry in front, so the later line is
    // the earlier PATH entry. The shims have to be prepended after
    // ~/.local/bin to end up ahead of it.
    const bin = path.indexOf('_red_path_prepend "$HOME/.local/bin"');
    const shims = path.indexOf("/shims");
    expect(bin).toBeGreaterThan(-1);
    expect(shims).toBeGreaterThan(bin);
  });

  test("and lose in turn to the RedSkills launchers red-dev writes", () => {
    // The runtime an operator types has to come out of the package set
    // their agent hosts read. mise shims the same npm package into its
    // own install tree, so red-dev's launcher directory is prepended
    // after the shims — and it is named here from the module that writes
    // into it, because a second spelling of that path in shell is a place
    // for the two to disagree silently.
    const shims = path.indexOf("/shims");
    const launchers = path.indexOf(runtimeBinDir("$HOME"));
    expect(launchers).toBeGreaterThan(shims);
  });

  test("are searched when verifying a tool the current run just installed", () => {
    // The installing run inherited its PATH from a shell that started
    // before the shim existed, so Bun.which cannot see it. Without this
    // a converge installs a tool and reports it missing on the next
    // line.
    const data = temp();
    const shims = join(data, "shims");
    mkdirSync(shims, { recursive: true });
    const shim = join(shims, "fixture-tool");
    writeFileSync(shim, "#!/bin/sh\necho 'fixture-tool 1.0.0'\n");
    chmodSync(shim, 0o755);

    withEnv({ MISE_DATA_DIR: data }, () => {
      const found = locateTool({ name: "fixture-tool", scope: "core" } as never);
      expect(found).toBe(shim);
    });
  });
});

describe("upgrading the suite", () => {
  test("names its tools, so it cannot reach the user's own runtimes", () => {
    // `mise upgrade` bare upgrades everything outdated in the active
    // config, and the active config is this fragment merged with
    // ~/.config/mise/config.toml — which the fragment's own header
    // promises red-dev never touches.
    const names = miseToolNames(ubuntu);
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("tq");
    expect(names).toContain("red");
    expect(names).not.toContain("node");
    expect(names).not.toContain("python");
  });

  test("uses the name a person types wherever the two disagree", () => {
    expect(miseToolNames(ubuntu)).toContain("tq");
    expect(miseToolNames(ubuntu)).not.toContain("github:reddb-io/toon");
  });

  test("cannot move a pinned tool, because the selector is exact", () => {
    const zellij = miseEntries(ubuntu).find((e) => e.spec.includes("zellij"));
    expect(zellij?.version).toBe("0.44.3-red.2");
    expect(zellij?.version).not.toBe("latest");
  });
});

describe("what moved to mise, and what deliberately did not", () => {
  const kindOf = (name: string) => {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) throw new Error(`no tool named ${name}`);
    return providerFor(tool, ubuntu).kind;
  };

  test("every third-party release red-dev used to download by hand", () => {
    // These had no updater at all: a converge that finds the binary on
    // PATH never asks how old it is, so each stayed at whatever version
    // install day happened to fetch.
    for (const name of ["starship", "atuin", "carapace", "yazi", "lazygit", "lazydocker"]) {
      expect(kindOf(name)).toBe("mise");
    }
  });

  test("our own CLIs, and red-dev itself", () => {
    for (const name of ["tq", "red", "red-dev"]) expect(kindOf(name)).toBe("mise");
  });

  test("tldr stays a release download, because mise cannot rename a binary", () => {
    // The release ships `tealdeer` and the command is `tldr`. Verified
    // against the real 1.8.1 release: neither the github: backend nor
    // ubi's exe= option renames the extracted file, and a shim called
    // `tealdeer` is a `tldr` that does not exist.
    expect(kindOf("tldr")).toBe("gh");
  });

  test("red-ui stays a .deb, because a bare binary would shadow it", () => {
    expect(kindOf("red-ui")).toBe("gh");
  });

  test("nothing on Windows moved off winget, which already has an updater", () => {
    const windows: Platform = { ...ubuntu, os: "windows", env: "windows" };
    for (const name of ["starship", "atuin", "lazygit", "yazi"]) {
      const tool = TOOLS.find((t) => t.name === name)!;
      expect(providerFor(tool, windows).kind).toBe("winget");
    }
  });
});
