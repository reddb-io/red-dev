/**
 * The order `red-dev update` advances a machine in.
 *
 * Pinned by walking it rather than by reading main.ts, because the order
 * is only worth anything if it is the one that executes: system
 * packages, then RedSkills, then the agent hosts, then the converge that
 * checks the result against the manifest. Every one of those depends on
 * what ran before it, and the converge depends on all of them.
 */

import { describe, expect, test } from "bun:test";
import { runUpdate, updateStageOrder, UPDATE_STAGES, type UpdateStage } from "./update-order.ts";

/** Walk the stages, recording which ones were reached. */
async function walk(
  fail: Partial<Record<UpdateStage, string>> = {},
  converge = 0,
): Promise<{ ran: UpdateStage[]; code: number; failures: string[] }> {
  const failures: string[] = [];
  const run = await runUpdate(
    async (stage) => {
      const message = fail[stage];
      if (message) throw new Error(message);
      return stage === "converge" ? converge : undefined;
    },
    (stage, message, fatal) => failures.push(`${stage}${fatal ? "!" : ""}: ${message}`),
  );
  return { ...run, failures };
}

describe("an update", () => {
  test("runs system, RedSkills, agents, then the converge, in that order", async () => {
    const { ran } = await walk();
    expect(ran.indexOf("system")).toBeLessThan(ran.indexOf("red-skills"));
    expect(ran.indexOf("red-skills")).toBeLessThan(ran.indexOf("agents"));
    expect(ran.indexOf("agents")).toBeLessThan(ran.indexOf("converge"));
    // The whole sequence, so the mise-managed suite cannot be moved
    // after the agents that may be installed on top of it without this
    // saying so.
    expect(ran).toEqual(["system", "red-skills", "suite", "agents", "converge"]);
    expect(updateStageOrder()).toEqual(ran);
  });

  test("declares each stage exactly once", () => {
    const stages = UPDATE_STAGES.map((spec) => spec.stage);
    expect(new Set(stages).size).toBe(stages.length);
  });

  test("ends when the package managers themselves fail", async () => {
    // Everything below system is installed on top of what it owns, so
    // there is nothing honest to do after it has failed.
    const { ran, code, failures } = await walk({ system: "apt-get update exited 100" });
    expect(ran).toEqual(["system"]);
    expect(code).toBe(1);
    expect(failures).toEqual(["system!: apt-get update exited 100"]);
  });

  test("carries past a stage that is allowed to fail, and names it", async () => {
    // An unreachable GitHub is not a reason to abandon an apt upgrade
    // that already succeeded. A machine that stops updating the moment
    // one vendor is down never finishes updating.
    const { ran, failures } = await walk({ "red-skills": "GitHub API 503", agents: "codex failed" });
    expect(ran).toEqual(["system", "red-skills", "suite", "agents", "converge"]);
    expect(failures).toEqual(["red-skills: GitHub API 503", "agents: codex failed"]);
  });

  test("answers with the converge's own exit code", async () => {
    // The question `red-dev update` answers is whether this machine is
    // now converged, and the converge is what knows.
    expect((await walk({}, 0)).code).toBe(0);
    expect((await walk({}, 2)).code).toBe(2);
    expect((await walk({ agents: "one host failed" }, 0)).code).toBe(0);
  });
});
