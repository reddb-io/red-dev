/**
 * One lock, two targets, and everything it has to refuse.
 *
 * The cases here are the ones a depot cannot survive being wrong about.
 * A lock that resolves differently on the machine that exports it and the
 * machine that imports it is not a lock, so resolution is asserted
 * byte-for-byte against the committed fixtures. A lock that installs the
 * Windows half of a workstation onto Ubuntu is worse than no lock, so
 * cross-target inputs are refused before a single step runs. And a
 * bootstrap that reports failure because nobody has logged into Claude
 * yet would make air-gapped provisioning permanently red, so an
 * unconfigured account is asserted to be a line in the report and not a
 * verdict.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { fixtureResolver } from "./fixtures/workstation-lock/releases.ts";
import {
  artifactMatches,
  auditWorkstationLock,
  encodeWorkstationLock,
  installFromLock,
  isExactVersion,
  lockReadiness,
  missingFromLock,
  parseWorkstationLock,
  planLockedInstall,
  REQUIRED_WORKSTATION_APPS,
  resolveWorkstationLock,
  surfacesFor,
  WORKSTATION_APPS,
  WORKSTATION_TARGETS,
  workstationTarget,
  workstationLockDigest,
  type LockStep,
  type ObservedTarget,
  type ReleaseResolver,
  type WorkstationLock,
} from "./workstation-lock.ts";

const AT = "2026-08-18T00:00:00Z";
const FIXTURES = join(import.meta.dir, "fixtures", "workstation-lock");
const UBUNTU = "ubuntu-24.04-x64";
const UBUNTU_26 = "ubuntu-26.04-x64";
const WINDOWS = "windows-11-x64+wsl-ubuntu-24.04";

const FIXTURE_FILES: Record<string, string> = {
  [UBUNTU]: "ubuntu-24.04-x64.json",
  [UBUNTU_26]: "ubuntu-26.04-x64.json",
  [WINDOWS]: "windows-11-x64-wsl-ubuntu-24.04.json",
};

function fixtureBytes(targetId: string): string {
  return readFileSync(join(FIXTURES, FIXTURE_FILES[targetId] as string), "utf8");
}

function fixtureLock(targetId: string): WorkstationLock {
  const parsed = parseWorkstationLock(fixtureBytes(targetId));
  if (!parsed.ok) throw new Error(`fixture ${targetId} does not parse: ${parsed.reason}`);
  return parsed.lock;
}

/** A machine with the target's surfaces and nothing installed on any of them. */
function cleanTarget(targetId: string): ObservedTarget {
  const target = workstationTarget(targetId);
  if (target === null) throw new Error(`no such target: ${targetId}`);
  return {
    id: target.id,
    surfaces: target.surfaces.map((s) => s.id),
    installed: [],
    authenticated: [],
  };
}

/** The same machine after everything in the lock landed at the locked version. */
function provisionedTarget(lock: WorkstationLock): ObservedTarget {
  return {
    ...cleanTarget(lock.target.id),
    installed: lock.apps.map((app) => ({
      id: app.id,
      surface: app.surface,
      version: app.version,
    })),
  };
}

/** A lock the resolver produced honestly, so it may be installed. */
async function resolvedLock(targetId: string): Promise<WorkstationLock> {
  const target = workstationTarget(targetId);
  if (target === null) throw new Error(`no such target: ${targetId}`);
  const result = await resolveWorkstationLock(target, AT, fixtureResolver, "resolved");
  if (!result.ok) throw new Error(`resolution refused: ${result.reason}`);
  return result.lock;
}

describe("resolving a lock", () => {
  test.each([UBUNTU, UBUNTU_26, WINDOWS])("%s resolves to exactly its committed fixture", async (id) => {
    const target = workstationTarget(id);
    expect(target).not.toBeNull();
    const result = await resolveWorkstationLock(target!, AT, fixtureResolver, "fixture");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Byte-for-byte: a depot exports these bytes and a clean machine
    // recomputes the digest over them, so a lock that re-encodes even
    // slightly differently is a lock that fails to import.
    expect(encodeWorkstationLock(result.lock)).toBe(fixtureBytes(id));
  });

  test("every fixture parses, and carries every required application", () => {
    for (const id of [UBUNTU, UBUNTU_26, WINDOWS]) {
      const lock = fixtureLock(id);
      expect(lock.origin).toBe("fixture");
      expect(auditWorkstationLock(lock)).toEqual([]);
      expect(missingFromLock(lock)).toEqual([]);
    }
  });

  test("every entry names an exact version, an official source and a checksum", () => {
    for (const id of [UBUNTU, UBUNTU_26, WINDOWS]) {
      for (const app of fixtureLock(id).apps) {
        expect(isExactVersion(app.version)).toBe(true);
        expect(app.source.coordinate).toContain(app.version);
        expect(app.source.origin.startsWith("https://")).toBe(true);
        expect(app.source.publisher.length).toBeGreaterThan(0);
        expect(app.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(app.provenance.reference.startsWith("https://")).toBe(true);
      }
    }
  });

  test("the Windows target puts the CLIs in WSL and the editor on Windows", () => {
    const lock = fixtureLock(WINDOWS);
    const surfaceOf = (id: string) => lock.apps.filter((a) => a.id === id).map((a) => a.surface);
    for (const cli of ["claude-code", "codex", "opencode", "redcode", "gemini", "pi", "hermes"]) {
      expect(surfaceOf(cli)).toEqual(["wsl-ubuntu-24.04-x64"]);
    }
    expect(surfaceOf("zellij")).toEqual(["wsl-ubuntu-24.04-x64"]);
    expect(surfaceOf("herdr")).toEqual(["wsl-ubuntu-24.04-x64"]);
    expect(surfaceOf("vscode")).toEqual(["windows-11-x64"]);
    // The two that both halves genuinely need, each from the channel that
    // side has: winget on Windows, the publisher's apt repository in WSL.
    expect(surfaceOf("mise")).toEqual(["windows-11-x64", "wsl-ubuntu-24.04-x64"]);
    expect(surfaceOf("red-dev")).toEqual(["windows-11-x64", "wsl-ubuntu-24.04-x64"]);
    const wingetMise = lock.apps.find((a) => a.id === "mise" && a.surface === "windows-11-x64");
    expect(wingetMise?.source.kind).toBe("winget");
    const aptMise = lock.apps.find((a) => a.id === "mise" && a.surface === "wsl-ubuntu-24.04-x64");
    expect(aptMise?.source.kind).toBe("apt-repo");
  });

  test("an Ubuntu desktop is one surface that takes both the CLIs and the editor", () => {
    const lock = fixtureLock(UBUNTU);
    expect(new Set(lock.apps.map((a) => a.surface))).toEqual(new Set([UBUNTU]));
    expect(lock.apps.find((a) => a.id === "vscode")?.source.kind).toBe("apt-repo");
  });

  test("the catalogue places every application on exactly one surface per target", () => {
    for (const target of WORKSTATION_TARGETS) {
      for (const app of WORKSTATION_APPS) {
        const surfaces = surfacesFor(app, target);
        expect(surfaces.length).toBeGreaterThan(0);
        if (app.runs !== "every") expect(surfaces.length).toBe(1);
      }
    }
  });

  test("a resolver that answers with a moving selector is refused", async () => {
    const moving: ReleaseResolver = async (app, surface) => {
      const honest = await fixtureResolver(app, surface);
      return app.id === "codex" ? { ...honest, version: "latest" } : honest;
    };
    const result = await resolveWorkstationLock(workstationTarget(UBUNTU)!, AT, moving);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("latest is a moving channel, not a release");
  });

  test.each(["latest", "stable", "next", "main", "*", "^1.2.3", "1.2.x", "v1.2.3", ""])(
    "%p is not an exact version",
    (value) => {
      expect(isExactVersion(value)).toBe(false);
    },
  );

  test.each(["1.0.56", "0.44.3-red.2", "2026.8.3", "24.7.0", "1.104.2"])(
    "%p is",
    (value) => {
      expect(isExactVersion(value)).toBe(true);
    },
  );
});

describe("the Ubuntu 26 target", () => {
  test("it is the Ubuntu desktop again, at the release that names it", () => {
    const target = workstationTarget(UBUNTU_26);
    expect(target).not.toBeNull();
    expect(target!.surfaces).toHaveLength(1);
    expect(target!.surfaces[0]).toMatchObject({
      id: UBUNTU_26,
      os: "linux",
      distro: "ubuntu",
      version: "26.04",
      arch: "x64",
      env: "desktop",
      role: "both",
    });
  });

  test("it places every application exactly where the Ubuntu 24 desktop does", async () => {
    // The whole claim of #213 is that a second Ubuntu is a surface and a
    // fixture rather than a second implementation, and this is what that
    // means concretely: the same applications, on one surface, from the
    // same channels. Only the surface name differs.
    const [older, newer] = await Promise.all([resolvedLock(UBUNTU), resolvedLock(UBUNTU_26)]);
    expect(newer.apps.map((a) => a.id)).toEqual(older.apps.map((a) => a.id));
    expect(new Set(newer.apps.map((a) => a.surface))).toEqual(new Set([UBUNTU_26]));
    expect(newer.apps.map((a) => a.source.kind)).toEqual(older.apps.map((a) => a.source.kind));
  });

  test("a resolver that answers with an Ubuntu 24 build is refused", async () => {
    const noble: ReleaseResolver = async (app, surface) => {
      const honest = await fixtureResolver(app, surface);
      if (app.id !== "herdr") return honest;
      const name = "herdr_0.9.4~noble_amd64.deb";
      return { version: honest.version, artifact: { name, sha256: honest.artifact.sha256 } };
    };
    const result = await resolveWorkstationLock(workstationTarget(UBUNTU_26)!, AT, noble);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      `herdr on ${UBUNTU_26}: artifact herdr_0.9.4~noble_amd64.deb is built for Ubuntu 24.04, not 26.04`,
    );
  });

  test("a resolver that answers with another platform's build is refused", async () => {
    const foreign: ReleaseResolver = async (app, surface) => {
      const honest = await fixtureResolver(app, surface);
      if (app.id !== "red-dev") return honest;
      const name = "red-dev-windows-x64.exe";
      return { version: honest.version, artifact: { name, sha256: honest.artifact.sha256 } };
    };
    const result = await resolveWorkstationLock(workstationTarget(UBUNTU_26)!, AT, foreign);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(
      `red-dev on ${UBUNTU_26}: artifact red-dev-windows-x64.exe is built for windows, not linux`,
    );
  });

  test("the same refusal reaches a lock that was already written down", () => {
    const lock = fixtureLock(UBUNTU_26);
    const app = lock.apps.find((a) => a.id === "vscode");
    expect(app).toBeDefined();
    const tampered: WorkstationLock = {
      ...lock,
      apps: lock.apps.map((a) =>
        a.id === "vscode"
          ? { ...a, artifact: { ...a.artifact, name: "code_1.104.2-1~noble_amd64.deb" } }
          : a,
      ),
    };
    // The digest complaint comes too, and that is fine: what matters is
    // that an import cannot be handed a 24-only artifact and proceed.
    expect(auditWorkstationLock(tampered)).toContain(
      `vscode on ${UBUNTU_26}: artifact code_1.104.2-1~noble_amd64.deb is built for Ubuntu 24.04, not 26.04`,
    );
  });
});

describe("reading a lock back", () => {
  test("reformatted bytes are refused rather than re-blessed", () => {
    const lock = fixtureLock(UBUNTU);
    const parsed = parseWorkstationLock(`${JSON.stringify(lock)}\n`);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("lock bytes are not canonical");
  });

  test("a digest that does not cover the contents is refused", () => {
    const lock = fixtureLock(UBUNTU);
    const tampered = {
      ...lock,
      apps: lock.apps.map((app) =>
        app.id === "codex" ? { ...app, version: "0.55.1", source: { ...app.source, coordinate: "@openai/codex@0.55.1" } } : app
      ),
    };
    const parsed = parseWorkstationLock(encodeWorkstationLock(tampered));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("lock digest does not match the locked contents");
  });

  test("another schema is refused by name", () => {
    const lock = fixtureLock(UBUNTU);
    const parsed = parseWorkstationLock(
      encodeWorkstationLock({ ...lock, schema: "red.workstation-lock.v2" }),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toContain("unsupported lock schema");
  });

  test("a source that resolves through a moving pointer is refused", () => {
    const lock = fixtureLock(UBUNTU);
    const app = lock.apps.find((a) => a.id === "redcode");
    expect(app).toBeDefined();
    const moved = {
      ...lock,
      apps: lock.apps.map((a) =>
        a.id === "redcode"
          ? {
              ...a,
              source: {
                ...a.source,
                origin: "https://github.com/reddb-io/redcode/releases/latest/download/redcode-linux-x64.tar.gz",
              },
            }
          : a
      ),
    };
    expect(auditWorkstationLock(moved).some((p) => p.includes("not an exact official URL"))).toBe(
      true,
    );
  });

  test("an entry on a surface the target does not have is refused", () => {
    const lock = fixtureLock(UBUNTU);
    const foreign = {
      ...lock,
      apps: lock.apps.map((a) => (a.id === "vscode" ? { ...a, surface: "windows-11-x64" } : a)),
    };
    expect(
      auditWorkstationLock(foreign).some((p) => p.includes("has no such surface")),
    ).toBe(true);
  });
});

describe("planning a clean target", () => {
  test.each([UBUNTU, WINDOWS])(
    "%s plans every coder CLI, companion, editor, runtime and tool",
    (id) => {
      const lock = fixtureLock(id);
      const planned = planLockedInstall(lock, cleanTarget(id));
      expect(planned.ok).toBe(true);
      if (!planned.ok) return;

      const installing = new Set(
        planned.plan.steps.filter((s) => s.action === "install").map((s) => s.app.id),
      );
      for (const required of REQUIRED_WORKSTATION_APPS) expect(installing).toContain(required);
      // Seven coder CLIs, named rather than counted: a lock that dropped
      // one and gained a companion would still count to seven.
      expect([...installing].filter((appId) =>
        lock.apps.some((a) => a.id === appId && a.kind === "coder")
      ).sort()).toEqual([
        "claude-code",
        "codex",
        "gemini",
        "hermes",
        "opencode",
        "pi",
        "redcode",
      ]);
      expect(planned.plan.steps.every((s) => s.action === "install")).toBe(true);
      expect(lockReadiness(planned.plan).ready).toBe(false);
    },
  );

  test("a machine already at the locked versions is ready and installs nothing", () => {
    const lock = fixtureLock(UBUNTU);
    const planned = planLockedInstall(lock, provisionedTarget(lock));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.steps.every((s) => s.action === "present")).toBe(true);
    const readiness = lockReadiness(planned.plan);
    expect(readiness.ready).toBe(true);
    expect(readiness.pending).toEqual([]);
  });

  test("a later version than the lock is replaced, not left alone", () => {
    const lock = fixtureLock(UBUNTU);
    const drifted = provisionedTarget(lock);
    const observed: ObservedTarget = {
      ...drifted,
      installed: drifted.installed.map((app) =>
        app.id === "zellij" ? { ...app, version: "0.44.4" } : app
      ),
    };
    const planned = planLockedInstall(lock, observed);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const step = planned.plan.steps.find((s) => s.app.id === "zellij") as LockStep;
    expect(step.action).toBe("replace");
    expect(step.observed).toBe("0.44.4");
  });
});

describe("cloud authentication", () => {
  test("a clean target reports every account as unconfigured, once", () => {
    const lock = fixtureLock(WINDOWS);
    const planned = planLockedInstall(lock, cleanTarget(WINDOWS));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.unconfigured.map((u) => u.app)).toEqual([
      "claude-code",
      "codex",
      "gemini",
      "hermes",
      "opencode",
      "pi",
      "redcode",
    ]);
    for (const entry of planned.plan.unconfigured) {
      expect(entry.service.length).toBeGreaterThan(0);
      expect(entry.evidence.length).toBeGreaterThan(0);
    }
  });

  test("an unconfigured account is reported, never a failed installation", async () => {
    const lock = await resolvedLock(UBUNTU);
    const installed: string[] = [];
    const result = await installFromLock(lock, cleanTarget(UBUNTU), async (step) => {
      installed.push(step.app.id);
      return { ok: true };
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Everything installed, nobody logged in anywhere: the run succeeded,
    // and what is left is named rather than counted as a failure.
    expect(result.report.failed).toEqual([]);
    expect(installed.length).toBe(lock.apps.length);
    expect(result.report.unconfigured.map((u) => u.app)).toContain("claude-code");

    // And the machine that run produced is ready, with the same seven
    // accounts still waiting for a person.
    const after = planLockedInstall(lock, provisionedTarget(lock));
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(lockReadiness(after.plan).ready).toBe(true);
    expect(lockReadiness(after.plan).unconfigured.length).toBe(7);
  });

  test("readiness ignores authentication entirely", () => {
    const lock = fixtureLock(UBUNTU);
    const planned = planLockedInstall(lock, provisionedTarget(lock));
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const readiness = lockReadiness(planned.plan);
    expect(readiness.ready).toBe(true);
    expect(readiness.unconfigured.length).toBe(7);
  });

  test("an account already configured stops being reported", () => {
    const lock = fixtureLock(UBUNTU);
    const observed: ObservedTarget = { ...cleanTarget(UBUNTU), authenticated: ["claude-code"] };
    const planned = planLockedInstall(lock, observed);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    expect(planned.plan.unconfigured.map((u) => u.app)).not.toContain("claude-code");
  });
});

describe("installing from a lock", () => {
  test("a resolved lock installs the complete target", async () => {
    const lock = await resolvedLock(WINDOWS);
    const steps: string[] = [];
    const result = await installFromLock(lock, cleanTarget(WINDOWS), async (step) => {
      steps.push(`${step.app.surface} ${step.app.id}`);
      return { ok: true };
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.installed.length).toBe(lock.apps.length);
    expect(result.report.present).toEqual([]);
    expect(steps.length).toBe(lock.apps.length);
  });

  test("one failing application does not stop or roll back the others", async () => {
    const lock = await resolvedLock(UBUNTU);
    const result = await installFromLock(lock, cleanTarget(UBUNTU), async (step) =>
      step.app.id === "hermes"
        ? { ok: false, detail: "python build failed" }
        : { ok: true }
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.report.failed).toEqual([
      { app: `hermes on ${UBUNTU}`, detail: "python build failed" },
    ]);
    expect(result.report.installed.length).toBe(lock.apps.length - 1);
  });

  test("a fixture lock plans but never installs", async () => {
    const lock = fixtureLock(UBUNTU);
    let ran = false;
    const result = await installFromLock(lock, cleanTarget(UBUNTU), async () => {
      ran = true;
      return { ok: true };
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("refusing to install a fixture lock");
    expect(ran).toBe(false);
  });

  test("a lock for the other target is refused before anything runs", async () => {
    const lock = await resolvedLock(WINDOWS);
    let ran = false;
    const result = await installFromLock(lock, cleanTarget(UBUNTU), async () => {
      ran = true;
      return { ok: true };
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(`lock provisions ${WINDOWS}, not ${UBUNTU}`);
    expect(ran).toBe(false);
  });

  test("a machine missing one of the target's surfaces is refused", async () => {
    const lock = await resolvedLock(WINDOWS);
    const halfMachine: ObservedTarget = {
      id: WINDOWS,
      surfaces: ["windows-11-x64"],
      installed: [],
      authenticated: [],
    };
    const result = await installFromLock(lock, halfMachine, async () => ({ ok: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("has no surface wsl-ubuntu-24.04-x64");
  });

  test("a mutable version is refused before anything runs", async () => {
    const lock = await resolvedLock(UBUNTU);
    const loose: WorkstationLock = {
      ...lock,
      apps: lock.apps.map((app) =>
        app.id === "codex"
          ? { ...app, version: "latest", source: { ...app.source, coordinate: "@openai/codex@latest" } }
          : app
      ),
    };
    let ran = false;
    const result = await installFromLock(loose, cleanTarget(UBUNTU), async () => {
      ran = true;
      return { ok: true };
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(ran).toBe(false);
  });

  test("an internally consistent but incomplete lock is still refused", async () => {
    const lock = await resolvedLock(UBUNTU);
    // Re-digested after the removal, so this is not caught as tampering:
    // it is a lock somebody could legitimately have built, which does not
    // provision a complete workstation and therefore installs nothing.
    const identity = {
      schema: lock.schema,
      target: lock.target,
      origin: lock.origin,
      resolvedAt: lock.resolvedAt,
      apps: lock.apps.filter((app) => app.id !== "hermes"),
    };
    const short: WorkstationLock = { ...identity, lockDigest: workstationLockDigest(identity) };
    expect(missingFromLock(short)).toEqual(["hermes"]);
    const result = await installFromLock(short, cleanTarget(UBUNTU), async () => ({ ok: true }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("lock is incomplete: hermes");
  });

  test("bytes that do not hash to the locked checksum are not the artifact", async () => {
    const lock = await resolvedLock(UBUNTU);
    const zellij = lock.apps.find((app) => app.id === "zellij");
    expect(zellij).toBeDefined();
    expect(artifactMatches(zellij!, "fixture:zellij@0.44.3-red.2:zellij-x86_64-unknown-linux-musl.tar.gz")).toBe(true);
    expect(artifactMatches(zellij!, "something else entirely")).toBe(false);
  });
});
