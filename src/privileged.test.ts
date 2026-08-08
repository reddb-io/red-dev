/**
 * The privileged batch, without a Windows host.
 *
 * Every claim this slice makes is about *which* items are asked for,
 * *when*, and how many times a person is interrupted — none of which
 * needs a capability to be installed to be checked. The two halves that
 * genuinely need Windows are behind BatchHost, so what is left is the
 * part that is worth pinning and the part a Linux machine can run.
 *
 * The idempotence tests read the composed script rather than run it, for
 * the same reason machineWideFontScript is a function: a batch that is
 * unsafe to re-run parses perfectly and reports success.
 */

import { describe, expect, test } from "bun:test";
import { convergeExit, outcomeForError } from "./converge.ts";
import {
  batchScript,
  privilegedItems,
  reportedError,
  runPrivilegedBatch,
  sectionNames,
  type BatchHost,
  type Elevation,
} from "./privileged.ts";
import { applicableScopes, itemsNeedingAdmin, TOOLS } from "./manifest.ts";
import { missingRights } from "./rights.ts";
import type { Capabilities, Platform } from "./platform.ts";

function platform(over: Partial<Platform> = {}): Platform {
  const caps: Capabilities = {
    apt: true,
    gui: false,
    systemd: true,
    winget: false,
    flatpak: false,
    ...(over.caps ?? {}),
  };
  return { os: "linux", distro: "ubuntu", version: "24.04", codename: "noble", env: "wsl", arch: "x64", ...over, caps };
}

const WSL = platform();
const WINDOWS = platform({
  os: "windows",
  env: "windows",
  distro: null,
  version: null,
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
});

const ITEMS = itemsNeedingAdmin(WINDOWS);

/** Everything the host was asked to do, in the order it was asked. */
interface Asked {
  calls: string[];
}

function host(over: Partial<BatchHost> = {}): BatchHost & Asked {
  const calls: string[] = [];
  return {
    calls,
    states: async (items) => {
      calls.push(`states:${items.map((t) => t.name).join(",")}`);
      return {};
    },
    elevated: async () => {
      calls.push("elevated?");
      return false;
    },
    consentPossible: () => {
      calls.push("consent?");
      return true;
    },
    applyHere: async (tool) => {
      calls.push(`apply:${tool.name}`);
    },
    elevate: async (items) => {
      calls.push(`elevate:${items.map((t) => t.name).join(",")}`);
      return { consent: "given", report: items.map((t) => `ok ${t.name}`) };
    },
    ...over,
  };
}

describe("the batch is the declared privileged set", () => {
  test("it contains every declared privileged item exactly once", () => {
    // Every row of the manifest whose column for this target needs
    // administrator, and no row twice.
    const declared = TOOLS.filter(
      (t) => t.win.needsAdmin === true && applicableScopes(WINDOWS).includes(t.scope),
    ).map((t) => t.name);
    expect(privilegedItems(WINDOWS, applicableScopes(WINDOWS)).map((t) => t.name)).toEqual(declared);
  });

  test("and a scope named twice does not put an item in it twice", () => {
    // `install` composes its scopes from the flag, the platform and the
    // first-run answers, which is three places a duplicate can come
    // from. Two prompts for one item is the exact failure this slice
    // exists to remove.
    const names = privilegedItems(WINDOWS, ["core", "core", "desktop", "core"]).map((t) => t.name);
    expect(names).toEqual([...new Set(names)]);
    expect(names).toEqual(itemsNeedingAdmin(WINDOWS, ["core", "desktop"]).map((t) => t.name));
  });

  test("a scope the run never reaches contributes nothing", () => {
    // `install core` must not be asked for administrator on behalf of a
    // desktop item it is not going to touch.
    for (const tool of privilegedItems(WINDOWS, ["core"])) expect(tool.scope).toBe("core");
  });

  test("every item in the batch has a section to run", () => {
    // The other direction of the registry, so an item that starts
    // needing administrator cannot be composed into a batch that has
    // nothing to run for it.
    expect(ITEMS.map((t) => t.name).sort()).toEqual(sectionNames().sort());
  });
});

describe("a plan with no privileged items", () => {
  test("produces no batch on any Linux target", () => {
    // sudo is its own path and it already works. A Ubuntu machine must
    // never be asked to elevate for a Windows requirement.
    for (const p of [WSL, platform({ env: "desktop", caps: { gui: true } as Capabilities })]) {
      expect(privilegedItems(p, applicableScopes(p))).toEqual([]);
    }
  });

  test("and requests no consent, nor anything else", async () => {
    // Not "consent is declined for an empty batch" — nothing is asked at
    // all. The common case is a machine that never sees this feature.
    const machine = host();
    expect(await runPrivilegedBatch([], machine)).toEqual([]);
    expect(machine.calls).toEqual([]);
  });
});

describe("an already-elevated session", () => {
  test("runs the batch without requesting consent", async () => {
    // Consent already given is not requested twice.
    const machine = host({
      elevated: async () => true,
      consentPossible: () => {
        throw new Error("an elevated session was asked to consent again");
      },
      elevate: async () => {
        throw new Error("an elevated session tried to elevate again");
      },
    });

    const steps = await runPrivilegedBatch(ITEMS, machine);
    expect(steps.map((s) => s.error ?? null)).toEqual(ITEMS.map(() => null));
    // Asked what is outstanding, then did it. The two overrides above
    // are the assertion that nothing in between happened; this is the
    // assertion that the work still did.
    expect(machine.calls).toEqual([
      `states:${ITEMS.map((t) => t.name).join(",")}`,
      ...ITEMS.map((t) => `apply:${t.name}`),
    ]);
  });

  test("and one item failing does not abandon the rest", async () => {
    const [first] = ITEMS;
    const machine = host({
      elevated: async () => true,
      applyHere: async (tool) => {
        if (tool.name === first?.name) throw new Error("dism fell over");
      },
    });
    const steps = await runPrivilegedBatch(ITEMS, machine);
    expect(steps[0]?.error).toBe("dism fell over");
    for (const step of steps.slice(1)) expect(step.error).toBeUndefined();
  });
});

describe("consent declined", () => {
  const declined = missingRights("administrator");

  test("names every item it left behind", async () => {
    // The run itself is finished — everything unprivileged converged in
    // the loop before this. What is owed the operator is which items are
    // still waiting, and the one thing to do about them.
    const machine = host({ elevate: async (): Promise<Elevation> => ({ consent: "refused" }) });
    const steps = await runPrivilegedBatch(ITEMS, machine);

    expect(steps.map((s) => s.tool.name)).toEqual(ITEMS.map((t) => t.name));
    for (const step of steps) expect(step.error).toBe(declined.message);
  });

  test("carries the wording the converge already reports for this", () => {
    // Deliberately asked of rights.ts rather than written here: an item
    // that ran out of rights mid-converge and one whose batch was
    // declined are the same outcome, and two wordings would read as two
    // different problems.
    expect(declined.message).toContain(declined.cause);
    expect(declined.message).toContain(declined.remedy);
  });

  test("and the converge reports it as deferred, not as a failure", async () => {
    // The other half of the promise: declining is a real choice, so a
    // run whose operator declined is a converged machine with work
    // outstanding — exit 2 — rather than a broken one.
    const machine = host({ elevate: async (): Promise<Elevation> => ({ consent: "refused" }) });
    const steps = await runPrivilegedBatch(ITEMS, machine);

    const outcomes = steps.map((s) => outcomeForError(s.error ?? ""));
    for (const outcome of outcomes) {
      expect(outcome.outcome).toBe("deferred");
      expect(outcome.remedy).toBe(declined.remedy);
    }
    expect(convergeExit({ failed: 0, deferred: outcomes.length })).toBe(2);
  });

  test("and what the converge prints names the command that finishes it", async () => {
    // The other end of the answer. Deferring tells the operator what was
    // left; this is the line that tells them what to run, and asking it
    // of the deferral itself is what stops the two from drifting apart.
    const machine = host({ elevate: async (): Promise<Elevation> => ({ consent: "refused" }) });
    const steps = await runPrivilegedBatch(ITEMS, machine);

    for (const step of steps) {
      expect(outcomeForError(step.error ?? "").remedy).toContain("red-dev privileged");
    }
  });

  test("a machine with nobody at it defers without raising a prompt", async () => {
    // CI, a pipe, a non-interactive SSH session. A consent dialog raised
    // where no one can answer it waits forever, and a converge that
    // hangs is worse than one that says what is left.
    const machine = host({
      consentPossible: () => false,
      elevate: async () => {
        throw new Error("a prompt was raised with nobody to answer it");
      },
    });
    const steps = await runPrivilegedBatch(ITEMS, machine);
    for (const step of steps) expect(step.error).toBe(declined.message);
  });
});

describe("work already done", () => {
  test("is reported without asking for consent again", async () => {
    // An operator who consented on the last run is not asked on this
    // one, which is the difference between a prompt that means something
    // and one people learn to dismiss.
    const machine = host({
      states: async (items) => Object.fromEntries(items.map((t) => [t.name, "finished" as const])),
      elevated: async () => {
        throw new Error("a finished batch went looking for rights");
      },
    });
    const steps = await runPrivilegedBatch(ITEMS, machine);
    expect(steps.map((s) => s.present)).toEqual(ITEMS.map(() => true));
  });

  test("while an unanswered probe still runs, because guessing done is the worse mistake", async () => {
    const machine = host({
      states: async (items) => Object.fromEntries(items.map((t) => [t.name, "unknown" as const])),
    });
    const steps = await runPrivilegedBatch(ITEMS, machine);
    expect(steps.some((s) => s.present)).toBe(false);
    expect(machine.calls).toContain(`elevate:${ITEMS.map((t) => t.name).join(",")}`);
  });
});

describe("what the elevated child reported", () => {
  test("ok is the item finishing", () => {
    expect(reportedError(["ok ssh-server"], "ssh-server")).toBeNull();
  });

  test("failed carries the message and nothing else", () => {
    expect(reportedError(["failed ssh-server dism fell over"], "ssh-server")).toBe("dism fell over");
  });

  test("silence about an item is not success", () => {
    // The child stopped before it got there. Claiming it worked is how a
    // half-configured machine reports as done.
    expect(reportedError(["ok other"], "ssh-server")).toContain("ssh-server");
  });

  test("one item's line is not read as another's", () => {
    expect(reportedError(["ok ssh-server-extra"], "ssh-server")).toContain("stopped before");
  });
});

/**
 * Every mutating cmdlet the batch may contain, and what makes running it
 * a second time safe.
 *
 * A guard string must appear in the composed text; `desired-state` is
 * for a cmdlet that sets what it is asked for rather than adding to it,
 * where running it again changes nothing by construction.
 *
 * Both directions are checked below, so a new privileged item cannot
 * quietly add an unguarded mutation: the batch is the one thing here an
 * operator re-runs after a partial failure, and it is the one thing they
 * have to consent to twice if it is not safe.
 */
const IDEMPOTENCE: Record<string, string> = {
  "Add-WindowsCapability": "if ($cap.State -ne 'Installed')",
  "Start-Service": "if ((Get-Service sshd).Status -ne 'Running')",
  "New-NetFirewallRule":
    "if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue))",
  "Set-Service": "desired-state",
  "Enable-WindowsOptionalFeature": "desired-state",
  "Stop-Service": "desired-state",
};

const RESULT = "C:\\Temp\\red-dev-privileged.txt";

describe("the batch text is safe to run again", () => {
  test("every mutation in it is guarded or sets a desired state", async () => {
    const script = await batchScript(ITEMS, RESULT);
    const mutations = Object.keys(IDEMPOTENCE).filter((op) => script.includes(op));
    // Not an empty check dressed up as a passing one: the batch has to
    // contain something to be worth asserting about.
    expect(mutations.length).toBeGreaterThan(0);

    for (const op of mutations) {
      const guard = IDEMPOTENCE[op]!;
      if (guard === "desired-state") continue;
      expect([op, script.includes(guard)]).toEqual([op, true]);
    }
  });

  test("and nothing mutates that has not said why that is safe", async () => {
    // The other direction. A section reaching for a cmdlet nobody has
    // reasoned about fails here rather than on somebody's machine, on
    // the second run, after the first one half-finished.
    const script = await batchScript(ITEMS, RESULT);
    const unaccounted = [...script.matchAll(/\b(?:Add|New|Set|Start|Stop|Remove|Enable|Disable)-[A-Za-z]+\b/g)]
      .map((m) => m[0])
      .filter((op) => !(op in IDEMPOTENCE))
      // Set-Content writes the report the parent reads back; it is the
      // batch's own bookkeeping rather than a change to the machine.
      .filter((op) => op !== "Set-Content");
    expect([...new Set(unaccounted)]).toEqual([]);
  });

  test("one item failing leaves the rest of the batch to run", async () => {
    // What makes a partial failure partial. An exception escaping a
    // section stops the whole child, so the items after it never run and
    // the report the parent reads is never written — turning one broken
    // item into a whole batch to consent to again.
    const script = await batchScript(ITEMS, RESULT);
    for (const tool of ITEMS) {
      expect([tool.name, script.includes(`# ---- ${tool.name}`)]).toEqual([tool.name, true]);
      expect([tool.name, script.includes(`$report += 'ok ${tool.name}'`)]).toEqual([tool.name, true]);
      expect([tool.name, script.includes(`$report += "failed ${tool.name}`)]).toEqual([tool.name, true]);
    }
    expect(script.split("try {").length - 1).toBe(ITEMS.length);
    expect(script.split("} catch {").length - 1).toBe(ITEMS.length);
  });

  test("no section can exit out from under the ones after it", async () => {
    // A composed script is not a script that runs alone. `exit` in any
    // section abandons every section after it and the report at the end,
    // and it does it silently — the parent sees a child that succeeded
    // and a file that was never written.
    const script = await batchScript(ITEMS, RESULT);
    expect(/(^|\n)\s*exit\b/.test(script)).toBe(false);
  });

  test("it reports back to a path the unelevated parent can read", async () => {
    // An elevated child is a separate process tree; its stdout does not
    // come home. Without this line the batch runs perfectly and the
    // converge learns nothing about what it did.
    const script = await batchScript(ITEMS, RESULT);
    expect(script).toContain(`Set-Content -LiteralPath '${RESULT}'`);
  });

  test("the same batch composes to the same text", async () => {
    expect(await batchScript(ITEMS, RESULT)).toBe(await batchScript(ITEMS, RESULT));
  });
});
