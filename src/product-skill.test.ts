/**
 * The Product skill has one failure mode worth testing for, and it is
 * not "did it write a file".
 *
 * It is the frozen copy. RedSkills' own checkout froze at the version
 * that first wired a machine and stayed there for a week while
 * everything reported itself current — the failure `updateRedSkills`
 * exists to fix. A skill installed once and never rewritten would repeat
 * it exactly, and worse: a document that confidently names the wrong
 * paths is worse than no document, because an agent will act on it.
 *
 * So the tests below pin content rather than existence, and pin the
 * refresh as its own behaviour rather than trusting that install covers
 * it.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { AGENTS, SKILL_HOSTS } from "./agents.ts";
import {
  MANAGED_MARKER,
  PRODUCT_SKILL_NAME,
  SKILL_HOMES,
  installProductSkill,
  planProductSkill,
  productSkillDocument,
  type MachineFacts,
} from "./product-skill.ts";
import type { Platform } from "./platform.ts";

const LINUX: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
} as Platform;

function facts(over: Partial<MachineFacts> = {}): MachineFacts {
  return {
    version: "1.0.25",
    state: "/home/someone/.local/state/red-dev",
    config: "/home/someone/.config",
    ...over,
  };
}

/** A machine with a home nobody else is writing into. */
function machine(): string {
  return mkdtempSync(`${tmpdir()}/red-dev-product-skill-`);
}

describe("where it goes", () => {
  test("into every installed host's skills home", async () => {
    const home = machine();
    const outcomes = await installProductSkill(LINUX, {
      home,
      installed: () => true,
      facts: facts(),
    });

    // Every host, not the first one that answered. Installing Codex a
    // week after Claude has to be enough to get the skill into it, which
    // is the same lesson SKILL_HOSTS is a table for.
    expect(outcomes.map((o) => o.state)).toEqual(["written", "written", "written"]);
    for (const path of [
      `${home}/.claude/skills/${PRODUCT_SKILL_NAME}/SKILL.md`,
      `${home}/.codex/skills/${PRODUCT_SKILL_NAME}/SKILL.md`,
      `${home}/.config/redcode/skills/${PRODUCT_SKILL_NAME}/SKILL.md`,
    ]) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain(`name: ${PRODUCT_SKILL_NAME}`);
    }
  });

  test("every host is a real agent, so the two lists cannot drift", () => {
    const keys = new Set(AGENTS.map((a) => a.key));
    for (const h of SKILL_HOMES) expect(keys.has(h.agent)).toBe(true);
  });

  test("the hosts are the ones red-skills already wires", () => {
    // Not a coincidence to be maintained by hand: these are the hosts
    // red-dev knows how to find a skills home for, and a host that
    // appears in one list and not the other is a machine that gets
    // RedSkills and no product knowledge, or the reverse.
    expect(SKILL_HOMES.map((h) => h.cmd).sort()).toEqual(SKILL_HOSTS.map((h) => h.cmd).sort());
  });
});

describe("a host with no agent", () => {
  test("is skipped with a reason", () => {
    const plans = planProductSkill(SKILL_HOMES, {
      home: "/home/someone",
      installed: (cmd) => cmd === "claude",
    });
    const skipped = plans.filter((p) => p.state === "skip");
    expect(skipped.map((p) => p.cmd)).toEqual(["codex", "redcode"]);
    for (const plan of skipped) {
      if (plan.state !== "skip") return;
      expect(plan.reason).toBe("no agent installed");
    }
  });

  test("and a skip always carries one — never an empty reason", () => {
    for (const deps of [
      { home: null, installed: () => true },
      { home: "/home/someone", installed: () => false },
    ]) {
      for (const plan of planProductSkill(SKILL_HOMES, deps)) {
        if (plan.state !== "skip") continue;
        expect(plan.reason.length).toBeGreaterThan(0);
      }
    }
  });

  test("writes nothing at all when nothing is installed", async () => {
    const home = machine();
    const outcomes = await installProductSkill(LINUX, {
      home,
      installed: () => false,
      facts: facts(),
    });
    expect(outcomes.every((o) => o.state === "skipped")).toBe(true);
    expect(existsSync(`${home}/.claude`)).toBe(false);
  });
});

describe("the refresh", () => {
  test("replaces install-day content rather than leaving it", async () => {
    const home = machine();
    const path = `${home}/.claude/skills/${PRODUCT_SKILL_NAME}/SKILL.md`;

    await installProductSkill(LINUX, {
      home,
      installed: (cmd) => cmd === "claude",
      facts: facts({ version: "1.0.1", state: "/old/state" }),
    });
    expect(readFileSync(path, "utf8")).toContain("/old/state");

    const again = await installProductSkill(LINUX, {
      home,
      installed: (cmd) => cmd === "claude",
      facts: facts({ version: "1.0.25", state: "/new/state" }),
    });

    expect(again[0]?.state).toBe("written");
    const body = readFileSync(path, "utf8");
    expect(body).toContain("/new/state");
    expect(body).not.toContain("/old/state");
    expect(body).toContain(`${MANAGED_MARKER} 1.0.25`);
  });

  test("a second run over identical content is quiet", async () => {
    const home = machine();
    const deps = { home, installed: (cmd: string) => cmd === "claude", facts: facts() };
    await installProductSkill(LINUX, deps);
    const again = await installProductSkill(LINUX, deps);
    // Not "written": every converge runs this, and a machine that is
    // already where it should be must not report a change it did not make.
    expect(again[0]?.state).toBe("unchanged");
  });

  test("runs from the same path that refreshes RedSkills", () => {
    // The freeze this exists to prevent is a copy that only ever gets
    // written by the install. Both doors — `red-dev update` through
    // updateRedSkills, and every converge through convergeRedSkills —
    // have to reach it, or one of them leaves the machine behind.
    const src = readFileSync("src/agents.ts", "utf8");
    for (const [from, to] of [
      ["export async function updateRedSkills", "export interface SkillHost"],
      ["export async function convergeRedSkills", "\n}\n"],
    ] as const) {
      const start = src.indexOf(from);
      expect(start).toBeGreaterThan(-1);
      expect(src.slice(start, src.indexOf(to, start))).toContain("refreshProductSkill");
    }
  });

  test("refreshes before red-skills can decide there is nothing to advance", () => {
    // updateRedSkills returns early on a machine with no red-skills
    // checkout. The Product skill is red-dev's own file and has nothing
    // to do with that checkout, so it has to be written above the return.
    const src = readFileSync("src/agents.ts", "utf8");
    const body = src.slice(
      src.indexOf("export async function updateRedSkills"),
      src.indexOf("export interface SkillHost"),
    );
    expect(body.indexOf("refreshProductSkill")).toBeLessThan(
      body.indexOf("nothing to advance"),
    );
  });
});

describe("a file red-dev did not write", () => {
  test("is left alone, with a reason", async () => {
    const home = machine();
    const path = `${home}/.claude/skills/${PRODUCT_SKILL_NAME}/SKILL.md`;
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(path, "---\nname: red-dev-machine\n---\n\nmine, hand written\n");

    const outcomes = await installProductSkill(LINUX, {
      home,
      installed: (cmd) => cmd === "claude",
      facts: facts(),
    });

    expect(outcomes[0]?.state).toBe("skipped");
    expect(outcomes[0]?.reason).toContain("not red-dev's");
    expect(readFileSync(path, "utf8")).toContain("mine, hand written");
  });

  test("but a managed one is rewritten without asking", async () => {
    const home = machine();
    const path = `${home}/.claude/skills/${PRODUCT_SKILL_NAME}/SKILL.md`;
    mkdirSync(path.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(path, `<!-- ${MANAGED_MARKER} 0.9.0 -->\nstale\n`);

    const outcomes = await installProductSkill(LINUX, {
      home,
      installed: (cmd) => cmd === "claude",
      facts: facts(),
    });
    expect(outcomes[0]?.state).toBe("written");
    expect(readFileSync(path, "utf8")).not.toContain("stale");
  });
});

describe("one host's failure", () => {
  test("does not stop the others", async () => {
    const outcomes = await installProductSkill(LINUX, {
      home: "/home/someone",
      installed: () => true,
      facts: facts(),
      read: () => null,
      write: (path) => {
        if (path.includes("codex")) throw new Error("read-only skills home");
      },
    });
    expect(outcomes.map((o) => o.state)).toEqual(["written", "failed", "written"]);
    expect(outcomes[1]?.reason).toBe("read-only skills home");
  });
});

describe("what the document says", () => {
  const body = productSkillDocument(facts());

  test("names this machine's paths, not a developer's", () => {
    // Generated for a reason: the state directory moves with
    // XDG_STATE_HOME and with Windows, and the configuration root moves
    // with a shared root. A static document would be right on exactly
    // one machine.
    const elsewhere = productSkillDocument(
      facts({ state: "C:/Users/someone/AppData/Local/red-dev/logs" }),
    );
    expect(body).toContain("/home/someone/.local/state/red-dev");
    expect(elsewhere).toContain("C:/Users/someone/AppData/Local/red-dev/logs");
    expect(elsewhere).not.toContain("/home/someone/.local/state/red-dev");
  });

  test("carries the frontmatter a host reads", () => {
    expect(body.startsWith("---\n")).toBe(true);
    expect(body).toContain(`name: ${PRODUCT_SKILL_NAME}`);
    expect(body).toMatch(/^description: .+/m);
  });

  test("covers what the product knows and RedSkills does not", () => {
    for (const subject of [
      "red-dev doctor",
      "red-dev logs",
      "red-dev plan",
      "red-dev privileged",
      "crash.log",
      "grep failed",
    ]) {
      expect(body).toContain(subject);
    }
  });

  test("says it is managed, so nobody edits it in place", () => {
    expect(body).toContain(MANAGED_MARKER);
    expect(body).toContain("red-dev update");
  });

  test("does not answer for RedSkills", () => {
    // Two skills that both describe process guidance is how an agent
    // ends up with contradictory instructions and no way to tell which
    // is current. This one stays on the product.
    expect(body).toContain("RedSkills carries the process guidance");
  });
});
