/**
 * Which registration wins on a machine that has both installers on it.
 *
 * The standalone one-liner registers the marketplace from GitHub and heals
 * a machine it finds registered from a directory. red-dev registers from
 * the directory mise advances, because that is the only source on this
 * machine that is pinned to the version mise resolved. Left to themselves
 * the two evict each other on every run: silent, endless, and invisible
 * except as a machine that installs plugins twice a day forever.
 *
 * So one of them is the declared owner, and where red-dev is present it is
 * red-dev. This file pins that half.
 *
 * What is asserted is the fact the *other* half reads — the entry the host
 * itself writes down, in the file the standalone installer's healing looks
 * at. Asserting an internal flag would let both repos be green about
 * different things; asserting the recorded registration kind is what makes
 * the two halves meet on one fact.
 *
 * The runner is injected and moves a fake HOME the way the real CLI would,
 * so all of this holds with no agent, no marketplace and no network.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Platform } from "./platform.ts";
import {
  MARKETPLACE_NAME,
  REGISTRATION_HOSTS,
  claudeRegistration,
  claudeRegistrationPath,
  codexRegistration,
  codexRegistrationPath,
  convergeMarketplaceOwnership,
  registrationIsOurs,
  type RegistrationOptions,
} from "./red-skills-registration.ts";

const UBUNTU: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

const PLUGINS = ["dev", "memory"];

function home(): string {
  return mkdtempSync(join(tmpdir(), "red-registration-"));
}

/** `~/.red/skills/current` — the path red-dev registers, not the version behind it. */
function currentOf(root: string): string {
  return `${root}/.red/skills/current`;
}

/** The entry Claude writes when the standalone one-liner registered from GitHub. */
function writeGithubRegistration(root: string): void {
  const path = claudeRegistrationPath(root);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      [MARKETPLACE_NAME]: {
        source: { source: "github", repo: "reddb-io/red-skills" },
        lastUpdated: "2026-08-02T12:35:21.550Z",
        autoUpdate: true,
      },
    }),
  );
}

/** The entry Claude writes when a marketplace was added from a path. */
function writeDirectoryRegistration(root: string, dir: string): void {
  const path = claudeRegistrationPath(root);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      [MARKETPLACE_NAME]: {
        source: { source: "directory", path: dir },
        lastUpdated: "2026-08-02T12:35:21.550Z",
        autoUpdate: true,
      },
    }),
  );
}

/** The table Codex writes under `[marketplaces.red-skills]`. */
function writeCodexRegistration(root: string, sourceType: string, source: string): void {
  const path = codexRegistrationPath(root);
  mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
  writeFileSync(
    path,
    [
      "[marketplaces.red-skills]",
      'last_updated = "2026-08-02T18:04:00Z"',
      `source_type = "${sourceType}"`,
      `source = "${source}"`,
      "",
    ].join("\n"),
  );
}

/**
 * A runner that records argv and moves the fake HOME the way the CLI would.
 *
 * Recording alone would only pin that red-dev issued an add; the point of
 * this slice is what the host has written down afterwards, which is the
 * fact the standalone installer reads. So the simulator writes the entry
 * an `add` produces and drops the one a `remove` takes away.
 */
function hostSim(
  root: string,
  code: (cmd: string[]) => number = () => 0,
): { calls: string[][]; run: (cmd: string[]) => Promise<number> } {
  const calls: string[][] = [];
  const run = async (cmd: string[]): Promise<number> => {
    calls.push(cmd);
    const exit = code(cmd);
    const [tool, , sub, verb, arg] = cmd;
    if (exit === 0 && sub === "marketplace" && verb === "add" && arg !== undefined) {
      if (tool === "claude") writeDirectoryRegistration(root, arg);
      else writeCodexRegistration(root, "local", arg);
    }
    // A remove really does drop the entry, which is why the add that
    // follows it is the step allowed to fail the host.
    if (exit === 0 && sub === "marketplace" && verb === "remove") {
      const path = tool === "claude" ? claudeRegistrationPath(root) : codexRegistrationPath(root);
      if (existsSync(path)) writeFileSync(path, tool === "claude" ? "{}" : "");
    }
    return exit;
  };
  return { calls, run };
}

/** A machine with both CLI hosts installed and a red-dev checkout on it. */
function converge(
  root: string,
  opts: RegistrationOptions = {},
): ReturnType<typeof convergeMarketplaceOwnership> {
  return convergeMarketplaceOwnership(UBUNTU, {
    home: root,
    source: currentOf(root),
    plugins: PLUGINS,
    present: () => true,
    ...opts,
  });
}

describe("where red-dev is present, the Directory registration wins", () => {
  test("a machine the standalone installer registered from GitHub ends up on the directory", async () => {
    const root = home();
    writeGithubRegistration(root);
    writeCodexRegistration(root, "git", "https://github.com/reddb-io/red-skills.git");

    const { run } = hostSim(root);
    const out = await converge(root, { run });

    expect(out.map((o) => o.host)).toEqual(REGISTRATION_HOSTS.map((h) => h.name));
    expect(out.every((o) => o.registered)).toBe(true);

    // The fact, read back off the host rather than off the outcome.
    expect(await claudeRegistration(root)).toEqual({
      kind: "directory",
      source: currentOf(root),
    });
    expect(await codexRegistration(root)).toEqual({
      kind: "directory",
      source: currentOf(root),
    });
  });

  test("the registration names `current`, which is the path that moves", async () => {
    // Not the version directory behind it. `current` is what mise repoints
    // when it advances the core, so a registration pinned to the version
    // it was made on is the frozen machine this whole spec is about.
    const root = home();
    const { calls, run } = hostSim(root);
    await converge(root, { run });

    const added = calls.filter((c) => c[2] === "marketplace" && c[3] === "add");
    expect(added.length).toBe(REGISTRATION_HOSTS.length);
    for (const cmd of added) expect(cmd[4]).toBe(currentOf(root));
  });

  test("and reinstalls the plugins the manifest declares, in manifest order", async () => {
    // They were installed from a marketplace that no longer exists under
    // that name: re-adding the source is not enough on its own.
    const root = home();
    const { calls, run } = hostSim(root);
    await converge(root, { run });

    for (const host of REGISTRATION_HOSTS) {
      const mine = calls.filter((c) => c[0] === host.cmd);
      const installed = mine
        .map((c) => c[c.length - 1] ?? "")
        .filter((a) => a.endsWith(`@${MARKETPLACE_NAME}`))
        .map((a) => a.slice(0, a.indexOf("@")));
      expect(installed, host.name).toEqual(PLUGINS);
    }
  });

  test("a host that refuses the add is not claimed as registered", async () => {
    const root = home();
    writeGithubRegistration(root);
    const { run } = hostSim(root, (cmd) => (cmd[3] === "add" ? 1 : 0));

    const out = await converge(root, { run });
    expect(out.every((o) => !o.registered)).toBe(true);
    for (const o of out) expect(o.reason, o.host).toContain("add");
  });

  test("an absent host is a fact about that host, not a failure", async () => {
    const root = home();
    const { calls, run } = hostSim(root);
    const out = await converge(root, { run, present: () => false });

    expect(calls).toEqual([]);
    expect(out.every((o) => !o.registered)).toBe(true);
    for (const o of out) expect(o.reason, o.host).toContain("not installed");
  });
});

describe("the registration kind, read where the standalone installer reads it", () => {
  test("Claude records it in known_marketplaces.json", () => {
    expect(claudeRegistrationPath("/home/x")).toBe(
      "/home/x/.claude/plugins/known_marketplaces.json",
    );
  });

  test("Codex records it in config.toml", () => {
    expect(codexRegistrationPath("/home/x")).toBe("/home/x/.codex/config.toml");
  });

  test("a github source and a git source are the same kind", async () => {
    const root = home();
    writeGithubRegistration(root);
    writeCodexRegistration(root, "git", "https://github.com/reddb-io/red-skills.git");

    expect((await claudeRegistration(root))?.kind).toBe("github");
    expect((await codexRegistration(root))?.kind).toBe("github");
  });

  test("a directory source and a local source are the same kind", async () => {
    const root = home();
    writeDirectoryRegistration(root, currentOf(root));
    writeCodexRegistration(root, "local", currentOf(root));

    expect((await claudeRegistration(root))?.kind).toBe("directory");
    expect((await codexRegistration(root))?.kind).toBe("directory");
  });

  test("no entry is no opinion, not a verdict", async () => {
    const root = home();
    expect(await claudeRegistration(root)).toBeNull();
    expect(await codexRegistration(root)).toBeNull();
  });

  test("an unreadable file is no opinion either", async () => {
    // Leaving the machine alone beats re-registering a marketplace on a
    // guess about a file we could not parse.
    const root = home();
    const path = claudeRegistrationPath(root);
    mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    writeFileSync(path, "{ not json");

    expect(await claudeRegistration(root)).toBeNull();
  });

  test("the outcome reports the kind the host has written down", async () => {
    // Both halves assert against one fact, so the outcome is not allowed
    // to be an opinion of its own: it is a read of the same boundary.
    const root = home();
    const { run } = hostSim(root);
    const out = await converge(root, { run });

    for (const o of out) expect(o.kind, o.host).toBe("directory");
    expect((await claudeRegistration(root))?.kind).toBe("directory");
  });

  test("a host that reports something else afterwards is reported, not assumed", async () => {
    // The add exited zero and the entry still says github. Trusting the
    // exit code here is how a machine gets reported as converged while
    // the standalone installer's registration is still in place.
    const root = home();
    const { run } = hostSim(root, () => 0);
    const out = await converge(root, {
      run: async (cmd) => {
        const code = await run(cmd);
        if (cmd[0] === "claude" && cmd[3] === "add") writeGithubRegistration(root);
        return code;
      },
    });

    const claude = out.find((o) => o.host === "claude");
    expect(claude?.registered).toBe(false);
    expect(claude?.kind).toBe("github");
  });
});

describe("a converge that has nothing to do", () => {
  test("issues no commands when the source is already correct", async () => {
    const root = home();
    await converge(root, { run: hostSim(root).run });

    const { calls, run } = hostSim(root);
    const out = await converge(root, { run });

    expect(calls).toEqual([]);
    expect(out.every((o) => !o.registered)).toBe(true);
    for (const o of out) {
      expect(o.kind, o.host).toBe("directory");
      expect(o.reason, o.host).toContain("already");
    }
  });

  test("but a directory registration pinned to a version directory is re-registered", async () => {
    // The failure mode "directory-sourced" alone cannot see: registered
    // once against `versions/v3.3.0`, which never moves again.
    const root = home();
    writeDirectoryRegistration(root, `${root}/.red/skills/versions/v3.3.0`);
    writeCodexRegistration(root, "local", `${root}/.red/skills/versions/v3.3.0`);

    const { calls, run } = hostSim(root);
    await converge(root, { run });

    expect(calls.filter((c) => c[3] === "add").length).toBe(REGISTRATION_HOSTS.length);
    expect((await claudeRegistration(root))?.source).toBe(currentOf(root));
  });
});

describe("a machine without red-dev is left exactly as it is", () => {
  test("no checkout means no registration to declare, and no commands", async () => {
    // This is the arbitration seen from the other side. red-dev only owns
    // the registration where red-dev has put a checkout on the machine;
    // with none there is nothing to register *from*, and the standalone
    // installer's GitHub registration is the only one on this machine.
    const root = home();
    writeGithubRegistration(root);
    const before = readFileSync(claudeRegistrationPath(root), "utf8");

    const { calls, run } = hostSim(root);
    const out = await converge(root, { run, source: null });

    expect(calls).toEqual([]);
    expect(out).toEqual([]);
    expect(readFileSync(claudeRegistrationPath(root), "utf8")).toBe(before);
    expect((await claudeRegistration(root))?.kind).toBe("github");
  });

  test("and nothing this slice adds writes to a machine it did not converge", async () => {
    // Not one file: no stamp, no marker, no config left behind on the way
    // to deciding there was nothing to do.
    const root = home();
    await converge(root, { run: hostSim(root).run, source: null });

    expect(existsSync(`${root}/.claude`)).toBe(false);
    expect(existsSync(`${root}/.codex`)).toBe(false);
    expect(existsSync(`${root}/.local`)).toBe(false);
  });
});

describe("Codex's config on Windows", () => {
  test("a source recorded as a TOML literal string is read, not read as nothing", async () => {
    // Codex writes the path in single quotes there, because it is full
    // of backslashes and TOML's literal string is what that is for.
    // Read as basic-only, this answered null and the check reported
    // "the marketplace is registered from nothing" about a marketplace
    // Codex had just recorded correctly — so Codex on Windows could
    // never verify, and the adoption was held.
    const home = mkdtempSync(join(tmpdir(), "red-codex-toml-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    const set = "\\\\?\\C:\\Users\\me\\.red\\skills\\sets\\4.0.1+41a32e805372";
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "[marketplaces.openai-bundled]",
        `source = '\\\\?\\C:\\Users\\me\\.codex\\bundled'`,
        "",
        "[marketplaces.red-skills]",
        'last_updated = "2026-08-20T02:16:51Z"',
        'source_type = "local"',
        `source = '${set}'`,
        "",
      ].join("\n"),
    );

    const registration = await codexRegistration(home);
    expect(registration).toEqual({ kind: "directory", source: set });
  });

  test("the extended-length prefix does not make it somebody else's directory", () => {
    // `\\?\C:\x` and `C:\x` are the same file. Compared as text without
    // saying so, they are two, and the registration reads as foreign.
    expect(
      registrationIsOurs(
        { kind: "directory", source: "\\\\?\\C:\\Users\\me\\.red\\skills\\current" },
        "C:\\Users\\me\\.red\\skills\\current",
      ),
    ).toBe(true);
  });

  test("and a basic string still reads, because that is what every other host writes", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-codex-basic-"));
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      ['[marketplaces.red-skills]', 'source_type = "local"', 'source = "/home/me/.red/skills/current"', ""].join("\n"),
    );
    expect(await codexRegistration(home)).toEqual({
      kind: "directory",
      source: "/home/me/.red/skills/current",
    });
  });
});
