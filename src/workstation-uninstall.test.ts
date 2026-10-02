/**
 * Taking the whole workstation back off, and what survives it.
 *
 * The rule src/uninstall.ts settles for one tool holds for all fourteen
 * of them: what this project put on the machine goes, and what carries
 * somebody's choices stays. So the assertions here are as much about
 * what is still there afterwards — the accounts, the dotfiles, the
 * backup taken before the first install — as about what went.
 *
 * The second uninstall is asserted for the same reason the second
 * converge is: an operator who runs it twice because the first was
 * ambiguous should get "there is nothing here" rather than a second
 * pass over paths that are already gone.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fixtureResolver } from "./fixtures/workstation-lock/releases.ts";
import {
  encodeWorkstationLock,
  resolveWorkstationLock,
  workstationLockPath,
  workstationTarget,
  type LockedApp,
  type ObservedTarget,
  type WorkstationLock,
} from "./workstation-lock.ts";
import {
  MACHINE_OWNED_ENTRIES,
  uninstallWorkstation,
  type WorkstationRemover,
} from "./workstation-uninstall.ts";

const AT = "2026-08-19T00:00:00Z";
const TARGET = "ubuntu-26.04-x64";

async function lockFor(target: string): Promise<WorkstationLock> {
  const found = workstationTarget(target);
  if (found === null) throw new Error(`no such target: ${target}`);
  const resolved = await resolveWorkstationLock(found, AT, fixtureResolver, "resolved");
  if (!resolved.ok) throw new Error(resolved.reason);
  return resolved.lock;
}

/** A home with a lock, every machine-owned entry, and one file that is not ours. */
function provisionedHome(lock: WorkstationLock): { home: string; keepsake: string } {
  const home = mkdtempSync(join(tmpdir(), "red-uninstall-"));
  const owned = join(home, ".red-skills");
  mkdirSync(owned, { recursive: true });
  for (const entry of MACHINE_OWNED_ENTRIES) {
    if (entry.endsWith(".json")) writeFileSync(join(owned, entry), "{}\n");
    else mkdirSync(join(owned, entry), { recursive: true });
  }
  writeFileSync(workstationLockPath(home), encodeWorkstationLock(lock));
  const keepsake = join(home, ".claude", "settings.json");
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(keepsake, '{"theme":"red"}\n');
  return { home, keepsake };
}

function machine(lock: WorkstationLock): ObservedTarget {
  return {
    id: lock.target.id,
    surfaces: lock.target.surfaces.map((s) => s.id),
    installed: lock.apps.map((app) => ({
      id: app.id,
      surface: app.surface,
      version: app.version,
    })),
    authenticated: [],
  };
}

describe("uninstalling a locked workstation", () => {
  test("everything the lock names goes, and the machine-owned state with it", async () => {
    const lock = await lockFor(TARGET);
    const { home, keepsake } = provisionedHome(lock);
    const gone: LockedApp[] = [];
    const remove: WorkstationRemover = async (app) => {
      gone.push(app);
      return { ok: true };
    };

    const result = await uninstallWorkstation({
      home,
      observed: machine(lock),
      remove,
      workers: async () => 0,
    });

    expect(result.outcome).toBe("removed");
    expect(result.code).toBe(0);
    expect(result.failed).toEqual([]);
    expect(gone.map((a) => a.id).sort()).toEqual(lock.apps.map((a) => a.id).sort());
    expect(result.removed).toHaveLength(lock.apps.length);
    expect(existsSync(workstationLockPath(home))).toBe(false);
    for (const entry of MACHINE_OWNED_ENTRIES) {
      expect(existsSync(join(home, ".red-skills", entry))).toBe(false);
    }
    // The one rule this shares with removing a single tool: configuration
    // is never removed as a side effect of removing a binary.
    expect(existsSync(keepsake)).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("an application the machine does not have is absent, not a failure", async () => {
    const lock = await lockFor(TARGET);
    const { home } = provisionedHome(lock);
    const observed = machine(lock);
    const partial: ObservedTarget = {
      ...observed,
      installed: observed.installed.filter((app) => app.id !== "zellij"),
    };

    const result = await uninstallWorkstation({
      home,
      observed: partial,
      remove: async () => ({ ok: true }),
      workers: async () => 0,
    });

    expect(result.outcome).toBe("removed");
    expect(result.absent).toEqual([`zellij on ${TARGET}`]);
    expect(result.failed).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  test("a removal that will not happen is reported, and the rest still go", async () => {
    const lock = await lockFor(TARGET);
    const { home } = provisionedHome(lock);
    const result = await uninstallWorkstation({
      home,
      observed: machine(lock),
      remove: async (app) =>
        app.id === "vscode" ? { ok: false, detail: "apt is held by another process" } : { ok: true },
      workers: async () => 0,
    });

    expect(result.outcome).toBe("partial");
    expect(result.code).toBe(1);
    expect(result.failed).toEqual([
      { app: `vscode on ${TARGET}`, detail: "apt is held by another process" },
    ]);
    // The lock stays, because something it names is still installed and
    // an operator retrying needs the record of what to retry against.
    expect(existsSync(workstationLockPath(home))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  test("running Workers hold the uninstall, and nothing is removed or stopped", async () => {
    const lock = await lockFor(TARGET);
    const { home } = provisionedHome(lock);
    let asked = 0;
    const result = await uninstallWorkstation({
      home,
      observed: machine(lock),
      remove: async () => {
        asked += 1;
        return { ok: true };
      },
      workers: async () => 2,
    });

    expect(result.outcome).toBe("held");
    expect(result.code).toBe(1);
    expect(result.workers).toBe(2);
    expect(asked).toBe(0);
    expect(result.writes).toEqual([]);
    expect(existsSync(workstationLockPath(home))).toBe(true);
    expect(result.reason).toContain("2 Worker");
    rmSync(home, { recursive: true, force: true });
  });

  test("a second uninstall writes nothing and says there is nothing here", async () => {
    const lock = await lockFor(TARGET);
    const { home } = provisionedHome(lock);
    const opts = {
      home,
      observed: machine(lock),
      remove: async () => ({ ok: true }),
      workers: async () => 0,
    };
    await uninstallWorkstation(opts);
    const second = await uninstallWorkstation({ ...opts, observed: { ...machine(lock), installed: [] } });

    expect(second.outcome).toBe("absent");
    expect(second.code).toBe(0);
    expect(second.writes).toEqual([]);
    expect(second.removed).toEqual([]);
    rmSync(home, { recursive: true, force: true });
  });

  test("a lock for another target is refused rather than half-applied", async () => {
    const lock = await lockFor(TARGET);
    const { home } = provisionedHome(lock);
    const elsewhere: ObservedTarget = { ...machine(lock), id: "ubuntu-24.04-x64" };
    const result = await uninstallWorkstation({
      home,
      observed: elsewhere,
      remove: async () => ({ ok: true }),
      workers: async () => 0,
    });

    expect(result.outcome).toBe("refused");
    expect(result.code).toBe(1);
    expect(result.reason).toContain("ubuntu-26.04-x64");
    expect(existsSync(workstationLockPath(home))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });
});
