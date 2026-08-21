/**
 * `red-dev agents update`, and the three promises it makes.
 *
 * Every host is refreshed by its own publisher's mechanism, so the first
 * half of this file pins the command line each mechanism produces — the
 * npm argv, the winget argv, the Microsoft Store argv, the vendor's own
 * self-update, the release archive and the vendor script. An update path
 * that quietly became one uniform reinstall would still pass a test that
 * only asked whether it succeeded.
 *
 * The second half pins the two behaviours that make running this twice
 * safe: a host that is already current is a skip carrying a reason, and
 * a host that fails is named without taking the rest of the run with it.
 */

import { describe, expect, test } from "bun:test";
import { agentInstallMethod, AGENTS, availableAgents, type AgentSpec } from "./agents.ts";
import {
  agentUpdateMechanism,
  planAgentUpdate,
  readUpdateOutcome,
  releaseTagFromLocation,
  sameRelease,
  updateAgents,
  type AgentUpdateOutcome,
} from "./agent-update.ts";
import type { Platform } from "./platform.ts";

const CAPS = { apt: true, gui: false, systemd: true, winget: false, flatpak: false };

const LINUX: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: CAPS,
};

const WSL: Platform = { ...LINUX, env: "wsl", caps: { ...CAPS, winget: true } };

const WINDOWS: Platform = {
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

/** A PATH lookup with no machine behind it. */
const found = (...commands: string[]) => (command: string): string | null =>
  commands.includes(command) ? `/usr/bin/${command}` : null;

const host = (key: string): AgentSpec => AGENTS.find((a) => a.key === key) as AgentSpec;

/** Resolve one host's plan, with everything it could ask the machine answered. */
function plan(key: string, p: Platform, overrides: Partial<{ npm: string | null }> = {}) {
  const spec = host(key);
  return planAgentUpdate(spec, p, {
    locate: found(spec.cmd),
    npm: overrides.npm === undefined ? "/home/u/.local/share/mise/shims/npm" : overrides.npm,
    platform: p.os === "windows" ? "win32" : "linux",
  });
}

/**
 * The machine questions, answered without asking a machine.
 *
 * `updateAgents` resolves npm once per run — for the hosts npm updates,
 * and for the shadow check that follows a release install. Left to the
 * default those spawn `npm ls -g`, which made one of these tests time
 * out at five seconds in CI while passing locally.
 */
const offMachine = {
  npm: async () => null,
  npmGlobals: async () => new Set<string>(),
};

describe("the update argv of each per-host mechanism", () => {
  test("npm reinstalls the package globally, pinned to latest", () => {
    const p = plan("gemini", LINUX);
    expect(p.state).toBe("ready");
    if (p.state !== "ready") return;
    expect(p.mechanism).toBe("npm");
    expect(p.step).toEqual({
      kind: "command",
      argv: [
        "/home/u/.local/share/mise/shims/npm",
        "install",
        "-g",
        "@google/gemini-cli@latest",
      ],
      env: { MISE_SKIP_RESHIM: "1" },
    });
  });

  test("the npm path still suppresses mise's implicit reshim", () => {
    // The unbounded second command that can strand a WSL converge at
    // "Reshimming mise 24..." forever. The install path suppresses it;
    // an update path that spawned the same npm without this would have
    // reintroduced exactly the hang that suppression was added for.
    for (const key of ["codex", "gemini", "openclaw"]) {
      const p = plan(key, WSL);
      expect(p.state).toBe("ready");
      if (p.state !== "ready" || p.step.kind !== "command") continue;
      expect(p.mechanism).toBe("npm");
      expect(p.step.env["MISE_SKIP_RESHIM"]).toBe("1");
    }
  });

  test("winget upgrades the package, silently and without interaction", () => {
    const p = plan("codex", WINDOWS);
    expect(p.state).toBe("ready");
    if (p.state !== "ready") return;
    expect(p.mechanism).toBe("winget");
    expect(p.step).toEqual({
      kind: "command",
      argv: [
        "cmd.exe",
        "/c",
        "winget",
        "upgrade",
        "--id",
        "OpenAI.Codex",
        "--exact",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ],
      env: {},
    });
  });

  test("the Microsoft Store path names its source, as the install path does", () => {
    // Without --source msstore the id resolves against the community
    // repository, where the ChatGPT entries belong to third parties.
    const p = plan("codex-desktop", WINDOWS);
    expect(p.state).toBe("ready");
    if (p.state !== "ready" || p.step.kind !== "command") return;
    expect(p.mechanism).toBe("msstore");
    expect(p.step.argv).toEqual([
      "cmd.exe",
      "/c",
      "winget",
      "upgrade",
      "--id",
      "9PLM9XGG6VKS",
      "--source",
      "msstore",
      "--exact",
      "--accept-package-agreements",
      "--accept-source-agreements",
      "--disable-interactivity",
    ]);
  });

  test("a host that updates itself is asked to, not reinstalled", () => {
    // Claude Code's installer leaves a self-updating binary behind, so
    // `claude update` is the publisher's own door. Re-running install.sh
    // would be red-dev going around it.
    const p = plan("claude-code", LINUX);
    expect(p.state).toBe("ready");
    if (p.state !== "ready") return;
    expect(p.mechanism).toBe("self-update");
    expect(p.step).toEqual({ kind: "command", argv: ["/usr/bin/claude", "update"], env: {} });
  });

  test("a GitHub release is re-resolved as an archive, not as a command", () => {
    const p = plan("redcode", LINUX);
    expect(p.state).toBe("ready");
    if (p.state !== "ready") return;
    expect(p.mechanism).toBe("github-release");
    expect(p.step).toEqual({
      kind: "release",
      repo: "reddb-io/redcode",
      asset: "redcode-linux-x64.tar.gz",
      bin: "redcode",
    });
  });

  test("a vendor script host re-runs the publisher's script", () => {
    const p = plan("muse", LINUX);
    expect(p.state).toBe("ready");
    if (p.state !== "ready") return;
    expect(p.mechanism).toBe("installer");
    expect(p.step).toEqual({ kind: "script", url: "https://dev.meta.ai/install.sh" });
  });

  test("the mechanism follows how the host was installed, not the catalog order", () => {
    // Codex carries a winget id and an npm package. Under WSL the
    // install path takes npm, so the update path must not reach for
    // winget just because the id is sitting in the same entry.
    expect(agentUpdateMechanism(host("codex"), WSL)).toBe("npm");
    expect(agentUpdateMechanism(host("codex"), WINDOWS)).toBe("winget");
    expect(agentUpdateMechanism(host("claude-code"), WINDOWS)).toBe("winget");
  });

  test("every host red-dev can install on a target also has a way to be updated", () => {
    // The mechanisms are derived from the install method, so this cannot
    // silently drift — but a future entry installed one way and updated
    // none would be a host that freezes on the version it arrived with.
    for (const p of [LINUX, WSL, WINDOWS]) {
      for (const spec of availableAgents(p)) {
        if (agentInstallMethod(spec, p) === null) continue;
        expect(agentUpdateMechanism(spec, p)).not.toBeNull();
      }
    }
  });
});

describe("a host with nothing to do", () => {
  test("is a skip with a reason when it is not installed at all", () => {
    const spec = host("gemini");
    const p = planAgentUpdate(spec, LINUX, { locate: () => null, npm: "/usr/bin/npm" });
    expect(p.state).toBe("skip");
    if (p.state !== "skip") return;
    expect(p.reason).toBe("not installed");
  });

  test("is a skip with a reason when the publisher says it is current", () => {
    // winget answers this with a non-zero exit — the steady state of an
    // idempotent machine, which a caller reading the code first reports
    // as a failure.
    expect(readUpdateOutcome({ code: 1, output: "No available upgrade found." })).toMatchObject({
      state: "skipped",
      reason: "already current",
    });
    expect(readUpdateOutcome({ code: 0, output: "changed 0 packages in 902ms" })).toMatchObject({
      state: "skipped",
      reason: "already current",
    });
    expect(readUpdateOutcome({ code: 0, output: "up to date in 431ms" })).toMatchObject({
      state: "skipped",
      reason: "already current",
    });
    expect(
      readUpdateOutcome({ code: 0, output: "Claude Code is already up to date (2.0.14)" }),
    ).toMatchObject({ state: "skipped", reason: "already current" });
  });

  test("is a skip with a reason when winget has no such package installed", () => {
    expect(
      readUpdateOutcome({
        code: 20,
        output: "No installed package found matching input criteria.",
      }),
    ).toMatchObject({ state: "skipped", reason: "not installed" });
  });

  test("and a skip always carries one — never an empty reason", () => {
    const skips = [
      readUpdateOutcome({ code: 1, output: "No available upgrade found." }),
      readUpdateOutcome({ code: 20, output: "No installed package found." }),
    ];
    for (const skip of skips) expect(skip.reason?.length ?? 0).toBeGreaterThan(0);
  });

  test("but a real failure stays a failure", () => {
    const outcome = readUpdateOutcome({
      code: 20,
      output: "No package found matching input criteria.",
    });
    expect(outcome.state).toBe("failed");
    expect(outcome.detail).toContain("No package found");
  });

  test("a release host already carrying the published tag is not re-downloaded", async () => {
    // 33 MB fetched to arrive where the machine already was. The tag
    // comes from the same redirect the download would have followed, so
    // asking costs nothing the install would not have spent anyway.
    let downloads = 0;
    const outcomes = await updateAgents([host("redcode")], LINUX, {
      locate: found("redcode"),
      releaseTag: async () => "v0.4.2",
      version: async () => "redcode 0.4.2",
      release: async () => {
        downloads++;
      },
      ...offMachine,
    });
    expect(downloads).toBe(0);
    expect(outcomes[0]).toMatchObject({ state: "skipped", reason: "already at v0.4.2" });
  });

  test("and one carrying an older version is", async () => {
    let downloads = 0;
    const outcomes = await updateAgents([host("redcode")], LINUX, {
      locate: found("redcode"),
      releaseTag: async () => "v0.4.2",
      version: async () => "redcode 0.4.1",
      release: async () => {
        downloads++;
      },
      ...offMachine,
    });
    expect(downloads).toBe(1);
    expect(outcomes[0]).toMatchObject({ state: "updated" });
  });

  test("and one whose version cannot be read is updated rather than assumed current", async () => {
    let downloads = 0;
    await updateAgents([host("redcode")], LINUX, {
      locate: found("redcode"),
      releaseTag: async () => null,
      version: async () => null,
      release: async () => {
        downloads++;
      },
      ...offMachine,
    });
    expect(downloads).toBe(1);
  });
});

describe("one host failing", () => {
  test("does not abort the hosts after it", async () => {
    // The failure that motivates this: ghInstallExactArchive throws on a
    // 404 and installerInstall throws on a TLS failure, either of which
    // would otherwise end an update with four working hosts still in
    // front of it.
    const order: string[] = [];
    const outcomes = await updateAgents(
      [host("claude-code"), host("redcode"), host("gemini")],
      LINUX,
      {
        ...offMachine,
        locate: found("claude", "redcode", "gemini"),
        npm: async () => "/usr/bin/npm",
        releaseTag: async () => null,
        version: async () => null,
        command: async (argv) => {
          order.push(argv.join(" "));
          return { code: 0, output: "updated" };
        },
        release: async () => {
          order.push("release");
          throw new Error("GitHub API 404 for reddb-io/redcode");
        },
      },
    );

    expect(outcomes.map((o) => o.state)).toEqual(["updated", "failed", "updated"]);
    expect(outcomes[1]).toMatchObject({
      key: "redcode",
      detail: "GitHub API 404 for reddb-io/redcode",
    });
    // The host after the failure ran, and ran its own mechanism.
    expect(order[2]).toContain("@google/gemini-cli@latest");
  });

  test("is named, so a run of eleven hosts says which one it was", async () => {
    const reported: AgentUpdateOutcome[] = [];
    await updateAgents([host("muse")], LINUX, {
      locate: found("muse"),
      script: async () => {
        throw new Error("installer exited 1: https://dev.meta.ai/install.sh");
      },
      report: (outcome) => reported.push(outcome),
      ...offMachine,
    });
    expect(reported).toHaveLength(1);
    expect(reported[0]).toMatchObject({ key: "muse", label: "Muse", state: "failed" });
  });

  test("and a host that cannot be updated at all names the fix", async () => {
    const outcomes = await updateAgents([host("gemini")], LINUX, {
      ...offMachine,
      locate: found("gemini"),
      // Spelled out after the spread, because it is the subject here
      // rather than a machine question being kept out of the way.
      npm: async () => null,
      command: async () => {
        throw new Error("npm should never have been reached");
      },
    });
    expect(outcomes[0]).toMatchObject({ state: "failed", fix: "red-dev install core" });
  });
});

describe("reading a release", () => {
  test("takes the tag out of the redirect the publisher answers with", () => {
    expect(
      releaseTagFromLocation(
        "https://github.com/reddb-io/redcode/releases/download/v0.4.2/redcode-linux-x64.tar.gz",
      ),
    ).toBe("v0.4.2");
    expect(releaseTagFromLocation("https://github.com/reddb-io/redcode/releases")).toBeNull();
  });

  test("compares it to what the host says it is, past the v and the noise", () => {
    expect(sameRelease("redcode 0.4.2 (linux-x64)", "v0.4.2")).toBe(true);
    expect(sameRelease("0.4.2", "0.4.2")).toBe(true);
    expect(sameRelease("redcode 0.4.1", "v0.4.2")).toBe(false);
    expect(sameRelease("no version here", "v0.4.2")).toBe(false);
  });
});

describe("when the catalog and the machine disagree about npm", () => {
  const codex = host("codex");
  const res = (npmOwns?: (pkg: string) => boolean) => ({
    locate: (_c: string) => "/home/cyber/.local/bin/codex",
    npm: "/usr/bin/npm",
    ...(npmOwns ? { npmOwns } : {}),
  });

  test("the catalog still decides on a machine nothing asked about", () => {
    // No npmOwns injected: every existing caller keeps the old answer.
    expect(agentUpdateMechanism(codex, WSL)).toBe("npm");
  });

  test("npm holding the package keeps npm as the mechanism", () => {
    expect(agentUpdateMechanism(codex, WSL, res(() => true))).toBe("npm");
  });

  test("npm not holding it hands the host to its own updater", () => {
    // The measured failure: `codex` resolved into
    // ~/.codex/packages/standalone, npm had never installed it, and
    // `npm install -g @openai/codex@latest` answered EEXIST every run.
    expect(agentUpdateMechanism(codex, WSL, res(() => false))).toBe("self-update");

    const plan = planAgentUpdate(codex, WSL, res(() => false));
    expect(plan.state).toBe("ready");
    if (plan.state !== "ready") return;
    expect(plan.step.kind).toBe("command");
    if (plan.step.kind !== "command") return;
    expect(plan.step.argv.join(" ")).toContain("codex update");
    expect(plan.step.argv.join(" ")).not.toContain("install -g");
  });

  test("a host with no self-updater is left on npm, wrong or not", () => {
    // Gemini declares npm and no `update` subcommand. Reclassifying it
    // would be inventing a mechanism its publisher never shipped.
    const gemini = host("gemini");
    expect(gemini.selfUpdate).toBeUndefined();
    expect(agentUpdateMechanism(gemini, WSL, res(() => false))).toBe("npm");
  });

  test("Claude Code is unaffected: its installer already elected self-update", () => {
    const claude = host("claude-code");
    expect(agentUpdateMechanism(claude, WSL, res(() => true))).toBe("self-update");
    expect(agentUpdateMechanism(claude, WSL, res(() => false))).toBe("self-update");
  });
});
