/**
 * What an adoption is allowed to take, and when.
 *
 * The failure this file exists about is the one the ADR 0008 cleanup
 * could produce: a machine where the standalone install was removed and
 * the package set had not landed, leaving no RedSkills at all. Every
 * test below is a sentence from the acceptance criteria turned into a
 * machine on disk — the Spec #185 workstation whole, the same machine
 * with a package set beside it, and one where a previous run was killed
 * halfway — built by src/fixtures/legacy-workstation.ts so that the
 * layout under test is the layout the production modules read.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  adoptionGate,
  adoptLegacyWorkstation,
  adoptionBackupRoot,
  adoptionRecordPath,
  inventoryLegacyWorkstation,
  readAdoptionRecord,
  type AdoptionVerification,
  type LegacyKind,
} from "./red-skills-adopt.ts";
import { HOST_ADAPTERS } from "./red-skills-hosts.ts";
import type { MarketplaceRegistration } from "./red-skills-registration.ts";
import { redSkillsCurrentLink } from "./red-skills-set.ts";
import {
  ADOPTED_SET,
  LEGACY_CURRENT,
  LEGACY_VERSIONS,
  materialiseLegacyWorkstation,
  PREVIOUS_SET,
  type LegacyShape,
} from "./fixtures/legacy-workstation.ts";

function machine(shape: LegacyShape = "standalone") {
  const home = mkdtempSync(join(tmpdir(), `red-adopt-${shape}-`));
  return materialiseLegacyWorkstation(home, shape);
}

/** The five companions and the seven hosts, all reporting well. */
function verified(): AdoptionVerification {
  return {
    active: ADOPTED_SET,
    hosts: HOST_ADAPTERS.map((a) => ({ host: a.name, status: "current" as const })),
    companions: (["runtimes", "redskilled", "herdr", "vscode", "zellij"] as const).map(
      (companion) => ({ companion, status: "current" as const }),
    ),
  };
}

/** Both marketplace hosts, after red-dev declared its own directory source. */
function ours(home: string): () => Promise<Record<string, MarketplaceRegistration | null>> {
  const source = redSkillsCurrentLink(home);
  return async () => ({
    claude: { kind: "directory", source },
    codex: { kind: "directory", source },
  });
}

/** Both hosts, still on the source `install.sh` gave them. */
const stillGit: () => Promise<Record<string, MarketplaceRegistration | null>> = async () => ({
  claude: { kind: "github", source: "reddb-io/red-skills" },
  codex: { kind: "github", source: "https://github.com/reddb-io/red-skills.git" },
});

function kinds(items: readonly { kind: LegacyKind }[]): Set<LegacyKind> {
  return new Set(items.map((item) => item.kind));
}

describe("the inventory of a Spec #185 workstation", () => {
  test("names every legacy state that Spec established", async () => {
    const { home } = machine();
    const inventory = await inventoryLegacyWorkstation({ home, registrations: stillGit });

    // One kind per sentence in the criterion: standalone trees and the
    // tarballs they came from, the Git/Directory registrations, the
    // generated OpenCode/RedCode and pi state, and the host caches.
    //
    // `companion-record` is deliberately not here. On a machine that has
    // never converged the new companion walk, that file is the only
    // thing that knows which editors took the extension, so it is not a
    // leftover yet — the test below is where it becomes one.
    expect(kinds(inventory.items)).toEqual(
      new Set([
        "standalone-tree",
        "standalone-tarball",
        "git-registration",
        "generated-host-state",
        "companion-asset",
        "host-plugin-copy",
      ]),
    );
    expect(inventory.bytes).toBeGreaterThan(0);
  });

  test("counts one tree per release the standalone installer left", async () => {
    const { home } = machine();
    const inventory = await inventoryLegacyWorkstation({ home, registrations: stillGit });
    const trees = inventory.items.filter((item) => item.kind === "standalone-tree");
    expect(trees.map((t) => t.detail).sort()).toEqual([...LEGACY_VERSIONS].sort());
  });

  test("a directory pinned at a version tree is legacy too", async () => {
    // The other Spec #185 shape: directory-sourced, correct on the day it
    // was written, and frozen after it because nothing moved the
    // directory it names. Only `current` follows the package set.
    const { home } = machine("mixed");
    const pinned = join(home, ".red-skills", "versions", LEGACY_CURRENT);
    const inventory = await inventoryLegacyWorkstation({
      home,
      registrations: async () => ({ claude: { kind: "directory", source: pinned } }),
    });
    expect(inventory.items.some((item) => item.kind === "git-registration")).toBe(true);
  });

  test("the registration red-dev declares is not an item", async () => {
    const { home } = machine("mixed");
    const inventory = await inventoryLegacyWorkstation({ home, registrations: ours(home) });
    expect(inventory.items.some((item) => item.kind === "git-registration")).toBe(false);
  });

  test("a directory somebody else made under versions/ is left alone", async () => {
    const { home } = machine();
    const mine = join(home, ".red-skills", "versions", "notes");
    writeFileSync(join(home, ".red-skills", "versions", "loose.txt"), "mine\n");
    Bun.spawnSync(["mkdir", "-p", mine]);
    writeFileSync(join(mine, "README.md"), "mine\n");

    const inventory = await inventoryLegacyWorkstation({ home, registrations: stillGit });
    const trees = inventory.items.filter((item) => item.kind === "standalone-tree");
    // The two markers the installer leaves are what makes a directory
    // there a RedSkills tree; without them it is somebody's afternoon.
    expect(trees.map((t) => t.detail)).not.toContain("notes");
  });

  test("a generated path the host registry owns is the current surface, not a leftover", async () => {
    const { home, config, generated } = machine("mixed");
    const kept = generated["opencode"]![0]!;
    writeFileSync(
      join(home, ".local", "share", "red-dev", "red-skills-hosts.json"),
      `${JSON.stringify(
        {
          schema: 2,
          hosts: {
            opencode: {
              setDigest: ADOPTED_SET.digest,
              setVersion: ADOPTED_SET.version,
              mode: "generator",
              plugins: ["dev"],
              stateDigest: "x",
              reload: "current",
              owned: [{ kind: "path", path: kept }],
              verifiedAt: "2026-08-19T04:00:00Z",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const inventory = await inventoryLegacyWorkstation({ home, registrations: ours(home) });
    const paths = inventory.items.map((item) => item.path);
    expect(paths).not.toContain(kept);
    // Its sibling is still a leftover, and so is the manifest's other entry.
    expect(paths).toContain(generated["opencode"]![1]!);
    // The manifest itself stays while one of the paths it names is live.
    expect(paths).not.toContain(join(config, "opencode", "redskills-install-manifest.txt"));
  });

  test("caches within active plus previous are not obsolete", async () => {
    const { home } = machine("mixed");
    const inventory = await inventoryLegacyWorkstation({ home, registrations: ours(home) });
    const copies = inventory.items.filter((item) => item.kind === "host-plugin-copy");
    for (const version of [ADOPTED_SET.version, PREVIOUS_SET.version]) {
      expect(copies.some((c) => c.detail.endsWith(version))).toBe(false);
    }
    // And the ones outside the window are.
    expect(copies.some((c) => c.detail.endsWith("3.16.0"))).toBe(true);
  });

  test("a copy a host still resolves through is never an item", async () => {
    // The rule that separates history from the plugin. Claude records
    // the install path of what it carries, so this is a question with an
    // answer rather than a guess.
    const { home } = machine();
    const cache = join(home, ".claude", "plugins", "cache", "red-skills", "dev", LEGACY_CURRENT);
    const inventory = await inventoryLegacyWorkstation({ home, registrations: stillGit });
    expect(inventory.items.map((item) => item.path)).not.toContain(cache);
  });

  test("an unreadable installed-plugins record refuses the whole host", async () => {
    const { home } = machine();
    writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), "{ not json");
    const inventory = await inventoryLegacyWorkstation({ home, registrations: stillGit });
    const claude = inventory.items.filter(
      (item) => item.kind === "host-plugin-copy" && item.host === "claude",
    );
    expect(claude).toEqual([]);
  });
});

describe("the gate the cleanup waits behind", () => {
  test("refuses a machine with no package set active", () => {
    const gate = adoptionGate({ active: null, hosts: [], companions: [] });
    expect(gate.ok).toBe(false);
  });

  test("refuses while any of the seven hosts was never reported", () => {
    const all = verified();
    const gate = adoptionGate({ ...all, hosts: all.hosts.slice(0, 6) });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("nothing verified");
  });

  test("refuses when a host is blocked or failed", () => {
    const all = verified();
    const gate = adoptionGate({
      ...all,
      hosts: [...all.hosts.slice(1), { host: all.hosts[0]!.host, status: "failed" }],
    });
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.reason).toContain("not reconciled into");
  });

  test("refuses when a companion did not converge", () => {
    const all = verified();
    const gate = adoptionGate({
      ...all,
      companions: [...all.companions.slice(1), { companion: "vscode", status: "blocked" }],
    });
    expect(gate.ok).toBe(false);
  });

  test("an absent host passes, because a machine without gemini is not a failure", () => {
    const all = verified();
    const gate = adoptionGate({
      ...all,
      hosts: all.hosts.map((h) => (h.host === "gemini" ? { host: "gemini", status: "absent" } : h)),
    });
    expect(gate.ok).toBe(true);
  });

  test("names the set, the hosts and the companions it stood on", () => {
    const gate = adoptionGate(verified());
    expect(gate.ok).toBe(true);
    if (gate.ok) {
      expect(gate.witness).toContain(ADOPTED_SET.version);
      expect(gate.witness).toContain("7 hosts");
    }
  });
});

describe("an adoption interrupted before it verified", () => {
  test("removes nothing and leaves the previous source usable", async () => {
    const { home } = machine("standalone");
    const adoption = await adoptLegacyWorkstation({
      home,
      registrations: stillGit,
      // The state a machine is in before the package set has landed:
      // nothing is active, so the gate cannot pass.
      verify: async () => ({ active: null, hosts: [], companions: [] }),
      at: "2026-08-19T04-00-00Z",
    });

    expect(adoption.outcome).toBe("held");
    expect(adoption.removed).toEqual([]);
    // The source itself, byte for byte: `current` still resolves, every
    // version tree is there, and both hosts still have their caches.
    expect(existsSync(join(home, ".red-skills", "current", "package.json"))).toBe(true);
    for (const version of LEGACY_VERSIONS) {
      expect(existsSync(join(home, ".red-skills", "versions", version, ".upstream"))).toBe(true);
    }
    expect(
      existsSync(join(home, ".claude", "plugins", "cache", "red-skills", "dev", "3.16.0")),
    ).toBe(true);
  });

  test("the backup it took stands, so the next run starts from it", async () => {
    const { home } = machine("standalone");
    const adoption = await adoptLegacyWorkstation({
      home,
      registrations: stillGit,
      verify: async () => ({ active: null, hosts: [], companions: [] }),
      at: "2026-08-19T04-00-00Z",
    });

    expect(adoption.backup).toBe(join(adoptionBackupRoot(home), "2026-08-19T04-00-00Z"));
    const manifest = JSON.parse(
      readFileSync(join(adoption.backup!, "inventory.json"), "utf8"),
    ) as { items: unknown[] };
    expect(manifest.items.length).toBe(adoption.inventory.items.length);
  });

  test("a machine left mid-adoption still resolves what it had", async () => {
    // The `interrupted` fixture: a backup on disk from a run that never
    // reached its cleanup. Nothing about that state may stop the machine
    // working, and a second adoption must be willing to start again.
    const { home } = machine("interrupted");
    expect(existsSync(join(home, ".red-skills", "current", "package.json"))).toBe(true);
    const inventory = await inventoryLegacyWorkstation({ home, registrations: stillGit });
    expect(inventory.items.length).toBeGreaterThan(0);
  });

  test("the backup is not under the directory an uninstall removes", () => {
    const home = "/home/example";
    // `~/.local/share/red-dev` is removed wholesale by removeConfiguration.
    // A backup kept there would be taken away by the uninstall that is
    // the most likely reason anyone would want it.
    expect(adoptionBackupRoot(home)).not.toContain("/.local/share/red-dev");
    expect(adoptionRecordPath(home)).toContain("/.local/share/red-dev");
  });
});

describe("a successful adoption", () => {
  async function adopted(shape: LegacyShape = "mixed") {
    const fixture = machine(shape);
    const adoption = await adoptLegacyWorkstation({
      home: fixture.home,
      registrations: ours(fixture.home),
      verify: async () => verified(),
      at: "2026-08-19T05-00-00Z",
    });
    return { ...fixture, adoption };
  }

  test("removes the standalone ownership and the caches beyond the window", async () => {
    const { home, adoption } = await adopted();
    expect(adoption.outcome).toBe("adopted");
    expect(existsSync(join(home, ".red-skills", "versions"))).toBe(false);
    expect(existsSync(join(home, ".red-skills", "cache"))).toBe(false);
    for (const version of ["3.16.0", "3.17.0", LEGACY_CURRENT]) {
      expect(
        existsSync(join(home, ".claude", "plugins", "cache", "red-skills", "brain", version)),
      ).toBe(false);
    }
    // Active and previous stay, which is the whole retention rule.
    for (const version of [ADOPTED_SET.version, PREVIOUS_SET.version]) {
      expect(
        existsSync(join(home, ".claude", "plugins", "cache", "red-skills", "dev", version)),
      ).toBe(true);
    }
  });

  test("leaves the package set it adopted onto exactly where it was", async () => {
    const { home, adoption } = await adopted();
    expect(adoption.outcome).toBe("adopted");
    expect(existsSync(join(home, ".red-skills", "current", "package.json"))).toBe(true);
    expect(existsSync(join(home, ".red-skills", "package-set.json"))).toBe(true);
  });

  test("preserves every file the operator wrote", async () => {
    const { adoption, userAuthored } = await adopted();
    expect(adoption.outcome).toBe("adopted");
    for (const [path, bytes] of Object.entries(userAuthored)) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(bytes);
    }
  });

  test("records exactly what it took, and nothing it did not", async () => {
    const { home, adoption } = await adopted();
    const record = readAdoptionRecord(home);
    expect(record?.outcome).toBe("adopted");
    expect(record?.removed.map((item) => item.path).sort()).toEqual(
      adoption.removed.map((item) => item.path).sort(),
    );
    // The kept items are named with a reason rather than dropped, so a
    // person can see why a machine is not fully adopted yet.
    for (const kept of adoption.kept) expect(kept.reason.length).toBeGreaterThan(0);
  });

  test("re-running it produces zero drift", async () => {
    const { home } = await adopted();
    const again = await adoptLegacyWorkstation({
      home,
      registrations: ours(home),
      verify: async () => verified(),
      at: "2026-08-19T06-00-00Z",
    });
    expect(again.outcome).toBe("clean");
    expect(again.removed).toEqual([]);
    expect(again.inventory.items).toEqual([]);
    // And it wrote no second backup, because there was nothing to back up.
    expect(again.backup).toBeNull();
    expect(existsSync(join(adoptionBackupRoot(home), "2026-08-19T06-00-00Z"))).toBe(false);
  });

  test("a registration the host has not moved off is kept, with the reason", async () => {
    // The gate passing does not license removing ownership the host
    // still reports. Read back at the host's own boundary, never
    // believed because a converge said it re-registered.
    const fixture = machine("mixed");
    const adoption = await adoptLegacyWorkstation({
      home: fixture.home,
      registrations: stillGit,
      verify: async () => verified(),
      at: "2026-08-19T05-00-00Z",
    });

    expect(adoption.outcome).toBe("adopted");
    const kept = adoption.kept.filter((k) => k.item.kind === "git-registration");
    expect(kept.length).toBe(2);
    expect(kept[0]!.reason).toContain("still records a github source");
    // And the rest of the adoption still happened.
    expect(existsSync(join(fixture.home, ".red-skills", "versions"))).toBe(false);
  });

  test("the companion record goes only once the registry covers it", async () => {
    const fixture = machine("mixed");
    const record = join(fixture.home, ".local", "share", "red-dev", "red-skills-extensions.json");

    const before = await adoptLegacyWorkstation({
      home: fixture.home,
      registrations: ours(fixture.home),
      verify: async () => verified(),
      at: "2026-08-19T05-00-00Z",
    });
    expect(before.outcome).toBe("adopted");
    // Nothing has written a companion registry, so the old record is
    // still the only thing that knows which editors took the extension.
    expect(existsSync(record)).toBe(true);

    writeFileSync(
      join(fixture.home, ".local", "share", "red-dev", "red-skills-companions.json"),
      `${JSON.stringify(
        {
          schema: 1,
          companions: {
            vscode: companionRecord(),
            herdr: companionRecord(),
          },
        },
        null,
        2,
      )}\n`,
    );

    const after = await adoptLegacyWorkstation({
      home: fixture.home,
      registrations: ours(fixture.home),
      verify: async () => verified(),
      at: "2026-08-19T06-00-00Z",
    });
    expect(after.outcome).toBe("adopted");
    expect(existsSync(record)).toBe(false);
  });
});

function companionRecord() {
  return {
    setDigest: ADOPTED_SET.digest,
    setVersion: ADOPTED_SET.version,
    version: ADOPTED_SET.version,
    stateDigest: "x",
    reload: "current",
    owned: [],
    verifiedAt: "2026-08-19T05:00:00Z",
  };
}

describe("what the converge gates the cleanup on", () => {
  const agents = readFileSync("src/agents.ts", "utf8");

  test("the adoption runs after the hosts, on the outcomes that run observed", () => {
    // Not on a record from an earlier converge and not on the existence
    // of a `current` link: the criterion is that cleanup does not begin
    // until the new package set, all seven hosts and the companions
    // verify, and the only thing that can answer that is what this run
    // just watched happen.
    const converge = agents.slice(agents.indexOf("export async function convergeRedSkills"));
    const reconciled = converge.indexOf("await reconcileSkillHosts(p)");
    const adopted = converge.indexOf("adoptSpec185Workstation(hosts, companions)");
    expect(reconciled).toBeGreaterThan(-1);
    expect(adopted).toBeGreaterThan(reconciled);
  });

  test("and it can never fail the reconciliation it is gated on", () => {
    // A machine that has just verified seven hosts and five companions
    // is a working machine whether or not a gigabyte came off it.
    const fn = agents.slice(agents.indexOf("async function adoptSpec185Workstation"));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).toContain("catch");
  });

  test("a machine that has recorded nothing is held rather than swept", async () => {
    // The default gate, with no injection at all: nothing has converged
    // here, so no host has a record, so nothing verified them.
    const { home } = machine("mixed");
    const adoption = await adoptLegacyWorkstation({
      home,
      registrations: ours(home),
      at: "2026-08-19T07-00-00Z",
    });
    expect(adoption.outcome).toBe("held");
    expect(existsSync(join(home, ".red-skills", "versions", LEGACY_CURRENT))).toBe(true);
  });
});

describe("what an uninstall may take afterwards", () => {
  test("the record of what red-dev removed goes with red-dev", () => {
    // `removeConfiguration` sweeps `~/.local/share/red-dev` wholesale,
    // which is where the adoption record lives: it is red-dev's own
    // bookkeeping and means nothing without red-dev.
    const uninstall = readFileSync("src/uninstall.ts", "utf8");
    expect(uninstall).toContain("${home}/.local/share/red-dev");
    expect(adoptionRecordPath("/home/example")).toContain("/.local/share/red-dev/");
  });

  test("the backup of what was on the machine before does not", () => {
    // The same rule the pre-red-dev dotfiles backup already follows: it
    // is the only copy of what was there, so an uninstall leaves it.
    const uninstall = readFileSync("src/uninstall.ts", "utf8");
    expect(uninstall).not.toContain(".local/state/red-dev");
    expect(adoptionBackupRoot("/home/example")).toContain("/.local/state/red-dev/");
  });

  test("nothing is removed that the record does not name", async () => {
    const fixture = machine("mixed");
    const adoption = await adoptLegacyWorkstation({
      home: fixture.home,
      registrations: ours(fixture.home),
      verify: async () => verified(),
      at: "2026-08-19T05-00-00Z",
    });
    const record = readAdoptionRecord(fixture.home);
    // Every path that stopped existing is one the record names, which is
    // what makes "removes only ownership recorded by red-dev" checkable
    // rather than a description of intent.
    const named = new Set(record!.removed.map((item) => item.path));
    for (const item of adoption.inventory.items) {
      if (existsSync(item.path)) continue;
      expect(named.has(item.path)).toBe(true);
    }
  });
});
