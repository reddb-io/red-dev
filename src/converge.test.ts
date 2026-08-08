/**
 * The converge loop is shared by the text reporter and the fullscreen
 * view, so a defect here shows up as two different-looking bugs. Its
 * dry-run path exercises the ordering, the counting and the observer
 * contract without touching a package manager, which is exactly the
 * part both presentations depend on.
 */

import { describe, expect, test } from "bun:test";
import { converge, convergeExit, countSteps, type StepResult } from "./converge.ts";
import { applicableScopes, toolsInScope } from "./manifest.ts";
import { privilegedItems, type BatchHost } from "./privileged.ts";
import type { Platform } from "./platform.ts";

const wsl: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: true },
};

/**
 * The one target with privileged items in it.
 *
 * A dry run is the only way to watch a Windows converge from here, and
 * it is enough for the question this asks: where the privileged items
 * appear in the run, not what they do when they get there.
 */
const windows: Platform = {
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

const ctx = { platform: wsl, theme: "dark", font: "firacode", opacity: 90 };

async function run(scopes: Parameters<typeof countSteps>[0]) {
  const events: string[] = [];
  const summary = await converge(
    { platform: wsl, ctx, scopes, dryRun: true },
    {
      scopeStart: (s, n) => events.push(`scope:${s}:${n}`),
      stepStart: (e) => events.push(`start:${e.tool}:${e.index}/${e.total}`),
      stepEnd: (r) => events.push(`end:${r.tool}:${r.outcome}`),
    },
  );
  return { events, summary };
}

describe("converge", () => {
  test("counts every tool in the requested scopes", () => {
    const core = toolsInScope("core").length;
    const optional = toolsInScope("optional").length;
    expect(countSteps(["core"])).toBe(core);
    expect(countSteps(["core", "optional"])).toBe(core + optional);
  });

  test("emits exactly one start and one end per tool", async () => {
    const { events } = await run(["optional"]);
    const starts = events.filter((e) => e.startsWith("start:")).length;
    const ends = events.filter((e) => e.startsWith("end:")).length;
    expect(starts).toBe(toolsInScope("optional").length);
    expect(ends).toBe(starts);
  });

  test("start always precedes the matching end", async () => {
    // The reporter opens a line on start and closes it on end. If they
    // ever interleave, output lands on the wrong row — which looks like
    // a rendering bug and is not one.
    const { events } = await run(["optional"]);
    let open = false;
    for (const e of events) {
      if (e.startsWith("start:")) {
        expect(open).toBe(false);
        open = true;
      } else if (e.startsWith("end:")) {
        expect(open).toBe(true);
        open = false;
      }
    }
    expect(open).toBe(false);
  });

  test("the index counts across scopes, not within them", async () => {
    // The progress bar's denominator is every step in the run. An index
    // that restarts per scope makes the bar jump backwards partway
    // through, which reads as a stall.
    const { events } = await run(["core", "optional"]);
    const indices = events
      .filter((e) => e.startsWith("start:"))
      .map((e) => Number(e.split(":")[2]!.split("/")[0]));
    expect(indices[0]).toBe(1);
    expect(indices).toEqual([...indices].sort((a, b) => a - b));
    expect(indices[indices.length - 1]).toBe(countSteps(["core", "optional"]));
  });

  test("every step reports the same total", async () => {
    const { events } = await run(["core"]);
    const totals = new Set(
      events.filter((e) => e.startsWith("start:")).map((e) => e.split("/")[1]),
    );
    expect(totals.size).toBe(1);
  });

  test("a dry run changes nothing and fails nothing", async () => {
    const { summary } = await run(["core"]);
    expect(summary.failed).toBe(0);
    // Dry-run steps are skipped or reported as already present; nothing
    // may claim to have been installed.
    const claimed = summary.results.filter(
      (r: StepResult) => r.outcome === "installed" || r.outcome === "applied",
    );
    expect(claimed).toHaveLength(0);
  });

  test("results and emitted ends agree", async () => {
    // The text path counts from the events, the fullscreen path from
    // the returned results. If those two disagree the same run reports
    // two different summaries depending on how you watched it.
    const { events, summary } = await run(["optional"]);
    expect(summary.results).toHaveLength(events.filter((e) => e.startsWith("end:")).length);
  });

  test("scopeStart announces each scope once, in order", async () => {
    const { events } = await run(["core", "optional"]);
    const scopes = events.filter((e) => e.startsWith("scope:")).map((e) => e.split(":")[1]);
    expect(scopes).toEqual(["core", "optional"]);
  });
});

describe("the privileged batch", () => {
  const scopes = applicableScopes(windows);

  async function runWindows(): Promise<string[]> {
    const events: string[] = [];
    await converge(
      { platform: windows, ctx: { ...ctx, platform: windows }, scopes, dryRun: true },
      { stepEnd: (r) => events.push(r.tool) },
    );
    return events;
  }

  test("runs after every unprivileged item, never between them", async () => {
    // The whole point of batching. An item that needs administrator
    // interrupts whatever is on the screen, so it interrupts at the end
    // or it interrupts a run someone is still watching.
    const order = await runWindows();
    const batch = privilegedItems(windows, scopes).map((t) => t.name);
    expect(batch.length).toBeGreaterThan(0);
    expect(order.slice(-batch.length)).toEqual(batch);
  });

  test("and each of its items is stepped exactly once", async () => {
    // Moved to the end, not duplicated there: an item reported twice
    // makes a converge look like it did the work twice, and the counts
    // the summary is built from stop adding up.
    const order = await runWindows();
    expect(order).toHaveLength(countSteps(scopes));
    expect(new Set(order).size).toBe(order.length);
  });

  test("a target with no privileged items is untouched by any of it", async () => {
    // The common case, and it must stay exactly as it was: same items,
    // same order, nothing lifted out and nothing appended.
    const { events } = await run(["core"]);
    const order = events.filter((e) => e.startsWith("end:")).map((e) => e.split(":")[1]);
    expect(order).toEqual(toolsInScope("core").map((t) => t.name));
  });
});

/**
 * The remainder on its own — the same batch, reached without the run in
 * front of it.
 *
 * A converge that deferred its privileged half leaves a machine where
 * everything else has converged, and re-running all of it to reach the
 * one thing outstanding is half an hour of work already done. So this
 * asks the same questions the batch answers inside a converge, of the
 * path an operator takes when that is all that is left: which items are
 * touched, how many times a person is interrupted, and what a machine
 * with nothing outstanding does.
 */
describe("only the privileged remainder", () => {
  const names = privilegedItems(windows, applicableScopes(windows)).map((t) => t.name);

  /** Everything the batch asked the machine for, in the order it asked. */
  function host(over: Partial<BatchHost> = {}, finished = false): BatchHost & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      states: async (items) => {
        calls.push(`states:${items.map((t) => t.name).join(",")}`);
        return finished
          ? Object.fromEntries(items.map((t) => [t.name, "finished" as const]))
          : {};
      },
      elevated: async () => false,
      consentPossible: () => true,
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

  async function remainder(
    p: Platform,
    machine: BatchHost,
  ): Promise<{ steps: StepResult[]; summary: Awaited<ReturnType<typeof converge>> }> {
    const steps: StepResult[] = [];
    const summary = await converge(
      {
        platform: p,
        ctx: { ...ctx, platform: p },
        scopes: applicableScopes(p),
        dryRun: false,
        only: "privileged",
        host: machine,
      },
      { stepEnd: (r) => steps.push(r) },
    );
    return { steps, summary };
  }

  test("runs the privileged batch and nothing else", async () => {
    // Not a converge with a filter in front of it: the unprivileged
    // items are never opened, never reported and never installed, which
    // is the whole reason to have this command rather than re-running
    // the converge that deferred.
    const machine = host();
    const { steps, summary } = await remainder(windows, machine);

    expect(names.length).toBeGreaterThan(0);
    expect(steps.map((s) => s.tool)).toEqual(names);
    expect(steps.length).toBeLessThan(countSteps(applicableScopes(windows)));
    expect(convergeExit(summary)).toBe(0);
  });

  test("requests consent once, for the whole batch", async () => {
    // One prompt, carrying every outstanding item. Two prompts for one
    // decision is the failure the batch exists to remove, and reaching
    // the batch by a different door must not reintroduce it.
    const machine = host();
    await remainder(windows, machine);
    expect(machine.calls.filter((c) => c.startsWith("elevate:"))).toEqual([
      `elevate:${names.join(",")}`,
    ]);
  });

  test("and not at all from an already-elevated session", async () => {
    // Consent already given is not requested twice. The two overrides
    // are the assertion that nothing asked; the calls are the assertion
    // that the work still happened.
    const machine = host({
      elevated: async () => true,
      consentPossible: () => {
        throw new Error("an elevated session was asked to consent");
      },
      elevate: async () => {
        throw new Error("an elevated session tried to elevate again");
      },
    });
    const { steps } = await remainder(windows, machine);

    expect(machine.calls).toEqual([
      `states:${names.join(",")}`,
      ...names.map((n) => `apply:${n}`),
    ]);
    expect(steps.map((s) => s.outcome)).toEqual(names.map(() => "applied"));
  });

  test("a machine with nothing outstanding succeeds having done nothing", async () => {
    // The answer to "did this finish" is the same whether it took a
    // consent prompt to get there or nothing at all. Running this on a
    // converged machine must not raise a dialog, and must not report a
    // problem it does not have.
    const machine = host(
      {
        elevated: async () => {
          throw new Error("a finished remainder went looking for rights");
        },
      },
      true,
    );
    const { steps, summary } = await remainder(windows, machine);

    expect(steps.map((s) => s.outcome)).toEqual(names.map(() => "present"));
    expect(machine.calls).toEqual([`states:${names.join(",")}`]);
    expect(convergeExit(summary)).toBe(0);
  });

  test("and a target with no privileged items touches nothing at all", async () => {
    // Every Ubuntu target. No probe, no elevation check and no prompt —
    // sudo is its own path and nothing here may disturb it.
    const machine = host();
    const { steps, summary } = await remainder(wsl, machine);

    expect(steps).toEqual([]);
    expect(machine.calls).toEqual([]);
    expect(convergeExit(summary)).toBe(0);
  });
});
