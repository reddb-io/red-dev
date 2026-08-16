/**
 * The Redwall is repainted by the daemon's host hook, and by nothing
 * else.
 *
 * These tests pin six claims, and the first of them is the one the rest
 * depend on: red-dev picked **the registered host hook** out of the two
 * mechanisms RedSkills ADR 0140 offers, and did not also keep a lane
 * watcher or the two-minute timer. Two mechanisms repainting one image
 * is worse than either — the second is the one nobody remembers exists
 * when the picture goes wrong — so "not both" is asserted here rather
 * than left as an intention in a comment.
 *
 * The seams are the operator's own machine: their `~/.red/config.yaml`,
 * `systemctl --user`, `schtasks`. Every test injects all of them, because
 * a suite that did not would rewrite the RedSkills policy of whoever
 * typed `bun test` and disable a timer on their laptop.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { BoundedCommandOptions, BoundedCommandResult } from "./bounded-command.ts";
import { captureStart, captureStop } from "./log.ts";
import type { Platform } from "./platform.ts";
import {
  applyRedwallHook,
  classifyHookPayload,
  declareRedwallHook,
  HOST_EVENT_ENV,
  legacyWrapperPath,
  redwallHookArgv,
  redwallHookBlock,
  redwallHookBoundary,
  redwallHookReason,
  redwallHookSkip,
  REDWALL_HOOK_KINDS,
  removeRedwallHook,
  runRedwallHook,
  withdrawRedwallHook,
} from "./redwall-hook.ts";

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const wsl: Platform = { ...desktop, env: "wsl", caps: { ...desktop.caps, gui: false } };

const windows: Platform = {
  os: "windows",
  distro: null,
  version: "11",
  codename: null,
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

const server: Platform = { ...desktop, env: "server", caps: { ...desktop.caps, gui: false } };

const BINARY = "/home/someone/.local/bin/red-dev";

/** A command runner that records instead of reaching the machine. */
function recorder(
  answer: (argv: string[]) => Partial<BoundedCommandResult> = () => ({}),
): {
  calls: string[][];
  run: (argv: string[], options?: BoundedCommandOptions) => Promise<BoundedCommandResult>;
} {
  const calls: string[][] = [];
  return {
    calls,
    run: async (argv) => {
      calls.push(argv);
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        timedOut: false,
        groupGone: false,
        ...answer(argv),
      };
    },
  };
}

/** A directory torn down with the process. */
function scratch(): string {
  return mkdtempSync(`${tmpdir()}/red-dev-redwall-hook-`);
}

/** Everything the log emitted while `body` ran. */
async function saidWhile(body: () => Promise<void>): Promise<string> {
  captureStart();
  let held: string[] = [];
  try {
    await body();
  } finally {
    held = captureStop();
  }
  return held.join("\n");
}

/**
 * Every module in this program, comments stripped.
 *
 * Stripped because these assertions are about what the program *does*,
 * and the module that picked the hook necessarily names the mechanism it
 * did not pick in order to say why.
 */
function everySource(): string[] {
  return readdirSync(import.meta.dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) =>
      readFileSync(`${import.meta.dir}/${name}`, "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n")
    );
}

describe("the mechanism this slice picked", () => {
  test("declares a host hook keyed by the three public kinds and nothing else", () => {
    const block = redwallHookBlock(redwallHookArgv(desktop, BINARY, null), 6).join("\n");

    // The public vocabulary of ADR 0140 decision 3, exactly. Not a
    // fourth kind — the daemon refuses one it does not publish — and not
    // a subset, because a Redwall that repaints on birth but not on
    // death drifts upward all day.
    expect(REDWALL_HOOK_KINDS).toEqual(["worker-birth", "worker-death", "worker-budget-kill"]);
    for (const kind of REDWALL_HOOK_KINDS) expect(block).toContain(`${kind}:`);
    expect(block).toContain("hooks:");
    expect(block).toContain(`argv: ["${BINARY}", "redwall"]`);
  });

  test("carries no {{…}} placeholder, which the daemon would refuse", () => {
    // The daemon substitutes four facts about a birth and refuses an
    // unknown placeholder rather than starting. A Redwall draws the
    // machine, not the Worker, so it needs none of them — and a template
    // that named one would be a hook that never fires.
    const block = redwallHookBlock(redwallHookArgv(windows, "C:\\bin\\red-dev.exe", null), 0);
    expect(block.join("\n")).not.toContain("{{");
  });

  test("and no lane watcher anywhere in the source: the choice is one or the other", () => {
    // The other mechanism the ADR offers is watching
    // `~/.red/redskilled/redskilled.log.toonl`. Picking the hook means
    // not also doing this — asserted against the source rather than
    // promised in a comment, because the failure mode of "both" is a
    // second repainter nobody remembers when the image is wrong.
    const sources = everySource();
    expect(sources.some((text) => text.includes("redskilled.log.toonl"))).toBe(false);
  });

  test("and no schedule: nothing in the source asks a supervisor to repaint", () => {
    const sources = everySource();
    // The two ways red-dev used to ask for a repeat: a systemd timer and
    // a per-minute scheduled task. Both are removed by this slice, so
    // neither may be written by it.
    expect(sources.some((text) => text.includes("OnUnitActiveSec"))).toBe(false);
    expect(sources.some((text) => text.includes('"/Create"'))).toBe(false);
  });
});

describe("one repaint per public event, and none for anything else", () => {
  test("each declared kind repaints exactly once", async () => {
    let repaints = 0;
    for (const kind of REDWALL_HOOK_KINDS) {
      const run = await runRedwallHook(async () => {
        repaints++;
        return "painted";
      }, { env: { [HOST_EVENT_ENV]: kind }, payload: async () => null });

      expect(run.reason).toBe("declared-kind");
      expect(run.regenerated).toBe(true);
      expect(run.result).toBe("painted");
    }
    // Three events, three repaints. Not two, which is a mechanism that
    // coalesces, and not six, which is two mechanisms.
    expect(repaints).toBe(3);
  });

  test("a kind outside the declared set repaints nothing at all", async () => {
    let repaints = 0;
    const run = await runRedwallHook(async () => {
      repaints++;
      return "painted";
    }, { env: { [HOST_EVENT_ENV]: "worker-metrics" }, payload: async () => null });

    expect(run.reason).toBe("foreign-kind");
    expect(run.kind).toBe("worker-metrics");
    expect(run.regenerated).toBe(false);
    expect(run.result).toBeNull();
    expect(repaints).toBe(0);
  });

  test("and a person typing the command is not an event at all", async () => {
    // `red-dev redwall` with no daemon behind it still repaints: the
    // guard is about kinds the daemon fired, not about locking the
    // command to one caller.
    let repaints = 0;
    const run = await runRedwallHook(async () => {
      repaints++;
      return "painted";
    }, { env: {} });

    expect(redwallHookReason({})).toBe("direct");
    expect(run.reason).toBe("direct");
    expect(run.kind).toBeNull();
    expect(repaints).toBe(1);
  });
});

describe("a record whose version this build does not read", () => {
  const v1 = JSON.stringify({ version: 1, protocol_version: 1, workers: [{ pid: 7 }] });

  test("still repaints, with whatever the run can resolve for itself", async () => {
    let repaints = 0;
    const run = await runRedwallHook(async () => {
      repaints++;
      return "painted";
    }, {
      env: { [HOST_EVENT_ENV]: "worker-birth" },
      payload: async () => JSON.stringify({ version: 99, protocol_version: 99, workers: [] }),
    });

    // The record is classified and never depended on. ADR 0140 decision
    // 4 has the consumer ask `host-state` after the event, which is what
    // `redwall.ts` does — so a document from a newer daemon costs a line
    // of explanation, never the repaint.
    expect(run.payload).toBe("unrecognised");
    expect(run.regenerated).toBe(true);
    expect(repaints).toBe(1);
  });

  test("as does one that never arrived", async () => {
    const run = await runRedwallHook(async () => "painted", {
      env: { [HOST_EVENT_ENV]: "worker-death" },
      payload: async () => null,
    });
    expect(run.payload).toBe("absent");
    expect(run.regenerated).toBe(true);
  });

  test("and a document of the version this build reads is named as such", async () => {
    const run = await runRedwallHook(async () => "painted", {
      env: { [HOST_EVENT_ENV]: "worker-birth" },
      payload: async () => v1,
    });
    expect(run.payload).toBe("understood");
    expect(run.regenerated).toBe(true);
  });

  test("classification alone: three answers, no throw", () => {
    expect(classifyHookPayload(v1)).toBe("understood");
    expect(classifyHookPayload("not json at all")).toBe("unrecognised");
    expect(classifyHookPayload("")).toBe("absent");
    expect(classifyHookPayload(null)).toBe("absent");
  });
});

describe("the topology the contract cannot serve", () => {
  test("native Windows is named, and said out loud rather than discovered", async () => {
    const dir = scratch();
    const path = `${dir}/config.yaml`;
    let outcome: Awaited<ReturnType<typeof applyRedwallHook>> | null = null;

    const said = await saidWhile(async () => {
      outcome = await applyRedwallHook(windows, {
        configPath: path,
        binary: "C:\\bin\\red-dev.exe",
        wrapper: `${dir}/nothing.vbs`,
        runner: async () => null,
        enabled: async () => true,
        run: recorder().run,
      });
    });

    // Reported, which is the whole of the criterion: decision 6 says a
    // native-Windows consumer watching a WSL-side lane receives nothing
    // forever with no error, and silence is the worst answer a contract
    // can give.
    expect(outcome!.boundary).toBe("wsl-unwatchable");
    expect(said).toContain("cannot reach a native-Windows Redwall");
    expect(said).toContain("ADR 0140 decision 6");
    // And with a remedy, because a limit with no next step is a limit
    // the reader has to solve themselves.
    expect(said).toContain("inside the distro");

    // The Windows-side declaration is still written: it covers a
    // Windows-side daemon, and refusing to declare anything would trade
    // a partial answer for none.
    expect(outcome!.action).toBe("declared");
    expect(readFileSync(path, "utf8")).toContain("worker-birth:");
  });

  test("a distro repaints the host desktop from its own side, so WSL crosses nothing", async () => {
    const dir = scratch();
    let outcome: Awaited<ReturnType<typeof applyRedwallHook>> | null = null;
    const said = await saidWhile(async () => {
      outcome = await applyRedwallHook(wsl, {
        configPath: `${dir}/config.yaml`,
        binary: BINARY,
        unitDir: `${dir}/units`,
        enabled: async () => true,
        run: recorder().run,
      });
    });

    // The distro's daemon writes the lane and fires the hook on the same
    // side, and the red-dev it fires reaches the Windows desktop through
    // interop the way it already resolves an address. Nothing watches
    // across the boundary because nothing watches at all.
    expect(redwallHookBoundary(wsl)).toBeNull();
    expect(outcome!.boundary).toBeNull();
    expect(said).not.toContain("ADR 0140 decision 6");
  });

  test("a machine with no screen is a skip, not a boundary", () => {
    expect(redwallHookSkip(server)).toBe("headless");
    // The retired timer also skipped a WSL distro without systemd,
    // because a user unit needs a user manager to hold it. A hook needs
    // no supervisor of its own, so that machine is served now.
    expect(redwallHookSkip({ ...wsl, caps: { ...wsl.caps, systemd: false } })).toBeNull();
  });
});

describe("declaring into an operator's own policy file", () => {
  test("creates the whole path when the file does not exist", async () => {
    const dir = scratch();
    const path = `${dir}/red/config.yaml`;

    const outcome = await applyRedwallHook(desktop, {
      configPath: path,
      binary: BINARY,
      unitDir: `${dir}/units`,
      enabled: async () => true,
      run: recorder().run,
    });

    expect(outcome.action).toBe("declared");
    expect(readFileSync(path, "utf8")).toBe(
      [
        "plugins:",
        "  dev:",
        "    redskilled:",
        "      # red-dev:redwall-hook — managed; rewritten on converge, removed on uninstall",
        "      hooks:",
        "        worker-birth:",
        `          argv: ["${BINARY}", "redwall"]`,
        "        worker-death:",
        `          argv: ["${BINARY}", "redwall"]`,
        "        worker-budget-kill:",
        `          argv: ["${BINARY}", "redwall"]`,
        "      # red-dev:redwall-hook end",
        "",
      ].join("\n"),
    );
  });

  test("keeps every comment and every key the operator wrote", () => {
    const original = [
      "# The operator's own notes about this machine.",
      "plugins:",
      "  dev:",
      "    redskilled:",
      "      # Two, because this laptop has eight cores and other work to do.",
      "      worker_ceiling: 2",
      "",
    ].join("\n");

    const edit = declareRedwallHook(original, [BINARY, "redwall"]);

    expect(edit.action).toBe("declared");
    expect(edit.document).toContain("# The operator's own notes about this machine.");
    expect(edit.document).toContain("# Two, because this laptop has eight cores");
    expect(edit.document).toContain("      worker_ceiling: 2");
    expect(edit.document).toContain("      hooks:");
  });

  test("follows the indentation the file already uses", () => {
    const original = ["plugins:", "    dev:", "        redskilled:", "            idle_ms: 900", ""]
      .join("\n");

    const edit = declareRedwallHook(original, [BINARY, "redwall"]);

    // The attachment point is the file's — that is the line a person
    // reads as belonging or not belonging. Inside its own block red-dev
    // nests two spaces, which is YAML's own step and the one every other
    // config in this repository uses.
    expect(edit.document).toContain("            hooks:");
    expect(edit.document).toContain("              worker-birth:");
  });

  test("is idempotent: a second converge writes nothing", () => {
    const first = declareRedwallHook("", [BINARY, "redwall"]);
    const second = declareRedwallHook(first.document, [BINARY, "redwall"]);
    expect(second.action).toBe("unchanged");
    expect(second.document).toBe(first.document);
  });

  test("repairs its own block when the binary moved under it", () => {
    const first = declareRedwallHook("", ["/old/red-dev", "redwall"]);
    const second = declareRedwallHook(first.document, [BINARY, "redwall"]);
    expect(second.action).toBe("declared");
    expect(second.document).toContain(`"${BINARY}"`);
    expect(second.document).not.toContain("/old/red-dev");
  });

  test("refuses a hooks block somebody else wrote", async () => {
    const dir = scratch();
    const path = `${dir}/config.yaml`;
    writeFileSync(
      path,
      ["plugins:", "  dev:", "    redskilled:", "      hooks:", "        worker-birth:", "          argv: [\"mine\"]", ""]
        .join("\n"),
    );

    let outcome: Awaited<ReturnType<typeof applyRedwallHook>> | null = null;
    const said = await saidWhile(async () => {
      outcome = await applyRedwallHook(desktop, {
        configPath: path,
        binary: BINARY,
        unitDir: `${dir}/units`,
        enabled: async () => true,
        run: recorder().run,
      });
    });

    // An operator declaring their own sink for the same three kinds is a
    // decision. Overwriting it would be red-dev resolving a conflict in
    // its own favour by force, on a file it does not own.
    expect(outcome!.action).toBe("refused");
    expect(said).toContain("declared by hand");
    expect(readFileSync(path, "utf8")).toContain('argv: ["mine"]');
  });

  test("withdraws when the preference goes off, and takes its own file with it", async () => {
    const dir = scratch();
    const path = `${dir}/config.yaml`;
    const seams = {
      configPath: path,
      binary: BINARY,
      unitDir: `${dir}/units`,
      run: recorder().run,
    };

    await applyRedwallHook(desktop, { ...seams, enabled: async () => true });
    expect(existsSync(path)).toBe(true);

    const off = await applyRedwallHook(desktop, { ...seams, enabled: async () => false });

    expect(off.action).toBe("withdrawn");
    // The file existed for one block and nothing else, so a file left
    // behind holding an empty `plugins:` chain would be a trace nothing
    // on the machine could explain.
    expect(existsSync(path)).toBe(false);
    expect(off.removed).toContain(path);
  });

  test("and leaves the operator's file standing when they had keys in it", () => {
    const original = ["plugins:", "  dev:", "    redskilled:", "      worker_ceiling: 2", ""].join(
      "\n",
    );
    const declared = declareRedwallHook(original, [BINARY, "redwall"]).document;

    const withdrawn = withdrawRedwallHook(declared);

    expect(withdrawn.removed).toBe(true);
    expect(withdrawn.document).toBe(original);
  });

  test("withdrawing a file that never had a block changes nothing", () => {
    const original = "plugins:\n  dev:\n    afk:\n      standing:\n        target: 2\n";
    expect(withdrawRedwallHook(original)).toEqual({ document: original, removed: false });
  });
});

describe("the scheduled repaint is removed by the same change", () => {
  test("converging takes the systemd timer away before declaring the hook", async () => {
    const dir = scratch();
    const units = `${dir}/units`;
    mkdirSync(units, { recursive: true });
    writeFileSync(`${units}/red-dev-redwall.timer`, "[Timer]\nOnUnitActiveSec=2min\n");
    writeFileSync(`${units}/red-dev-redwall.service`, "[Service]\n");

    const runs = recorder();
    let outcome: Awaited<ReturnType<typeof applyRedwallHook>> | null = null;
    const said = await saidWhile(async () => {
      outcome = await applyRedwallHook(desktop, {
        configPath: `${dir}/config.yaml`,
        binary: BINARY,
        unitDir: units,
        enabled: async () => true,
        run: runs.run,
      });
    });

    // Disabled before the files go: a unit whose file was deleted first
    // leaves its symlink in timers.target.wants, and systemd complains
    // about that on every reload for good.
    expect(runs.calls[0]).toEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      "red-dev-redwall.timer",
    ]);
    expect(runs.calls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(existsSync(`${units}/red-dev-redwall.timer`)).toBe(false);
    expect(existsSync(`${units}/red-dev-redwall.service`)).toBe(false);
    expect(outcome!.removed).toContain(`${units}/red-dev-redwall.timer`);
    expect(said).toContain("the two-minute timer is gone");

    // And the hook is in place, so the machine is never between the two.
    expect(outcome!.action).toBe("declared");
  });

  test("the timer goes even when the preference is off", async () => {
    const dir = scratch();
    const units = `${dir}/units`;
    mkdirSync(units, { recursive: true });
    writeFileSync(`${units}/red-dev-redwall.timer`, "[Timer]\n");

    const outcome = await applyRedwallHook(desktop, {
      configPath: `${dir}/config.yaml`,
      binary: BINARY,
      unitDir: units,
      enabled: async () => false,
      run: recorder().run,
    });

    // A preference that is off means no repaints, and a timer left
    // enabled would keep making them from a mechanism nobody can see.
    expect(existsSync(`${units}/red-dev-redwall.timer`)).toBe(false);
    expect(outcome.removed).toContain(`${units}/red-dev-redwall.timer`);
  });

  test("a machine that never held one spawns nothing to find that out", async () => {
    const dir = scratch();
    const runs = recorder();

    await applyRedwallHook(desktop, {
      configPath: `${dir}/config.yaml`,
      binary: BINARY,
      unitDir: `${dir}/units`,
      enabled: async () => true,
      run: runs.run,
    });

    // The common machine forever after this ships. Asking systemd on
    // every converge, on every machine, whether a retired feature is
    // still retired is a process spent to learn nothing.
    expect(runs.calls).toEqual([]);
  });

  test("Windows loses its task and the wrapper that named the binary", async () => {
    const dir = scratch();
    const wrapper = legacyWrapperPath("C:\\bin\\red-dev.exe").replace("C:\\bin", dir);
    writeFileSync(wrapper, "' the retired wrapper");
    const runs = recorder();

    const outcome = await applyRedwallHook(windows, {
      configPath: `${dir}/config.yaml`,
      binary: "C:\\bin\\red-dev.exe",
      wrapper,
      runner: async () => null,
      enabled: async () => true,
      run: runs.run,
    });

    expect(runs.calls).toContainEqual(["schtasks", "/Delete", "/TN", "red-dev-redwall", "/F"]);
    expect(existsSync(wrapper)).toBe(false);
    expect(outcome.removed).toContain(wrapper);
  });

  test("and asks Windows nothing when the wrapper is not there", async () => {
    const dir = scratch();
    const runs = recorder();

    await applyRedwallHook(windows, {
      configPath: `${dir}/config.yaml`,
      binary: "C:\\bin\\red-dev.exe",
      wrapper: `${dir}/absent.vbs`,
      runner: async () => null,
      enabled: async () => true,
      run: runs.run,
    });

    // The version that installed either wrote both, so the wrapper's
    // presence is the free signal that a legacy schedule exists.
    expect(runs.calls).toEqual([]);
  });
});

describe("uninstall withdraws what this slice declared", () => {
  test("the block goes, whatever the preference still says", async () => {
    const dir = scratch();
    const path = `${dir}/config.yaml`;
    const seams = {
      configPath: path,
      binary: BINARY,
      unitDir: `${dir}/units`,
      run: recorder().run,
    };

    await applyRedwallHook(desktop, { ...seams, enabled: async () => true });

    // Never consulting the preference is the point: a machine being
    // uninstalled keeps its answer to "did you want a Redwall" so that
    // reinstalling restores it, and a declaration left behind would have
    // the daemon exec a path with no binary at it on every birth.
    const outcome = await removeRedwallHook(desktop, { ...seams, enabled: async () => true });

    expect(outcome.action).toBe("withdrawn");
    expect(existsSync(path)).toBe(false);
  });

  test("but only red-dev's block: the operator's policy survives", async () => {
    const dir = scratch();
    const path = `${dir}/config.yaml`;
    const original = [
      "# Machine policy.",
      "plugins:",
      "  dev:",
      "    redskilled:",
      "      worker_ceiling: 4",
      "",
    ].join("\n");
    writeFileSync(path, original);
    const seams = {
      configPath: path,
      binary: BINARY,
      unitDir: `${dir}/units`,
      run: recorder().run,
    };

    await applyRedwallHook(desktop, { ...seams, enabled: async () => true });
    await removeRedwallHook(desktop, seams);

    expect(readFileSync(path, "utf8")).toBe(original);
  });

  test("and the retired schedule comes out with it", async () => {
    const dir = scratch();
    const units = `${dir}/units`;
    mkdirSync(units, { recursive: true });
    writeFileSync(`${units}/red-dev-redwall.timer`, "[Timer]\n");
    writeFileSync(`${units}/red-dev-redwall.service`, "[Service]\n");

    const outcome = await removeRedwallHook(desktop, {
      configPath: `${dir}/config.yaml`,
      binary: BINARY,
      unitDir: units,
      run: recorder().run,
    });

    expect(outcome.removed).toContain(`${units}/red-dev-redwall.timer`);
    expect(existsSync(`${units}/red-dev-redwall.service`)).toBe(false);
  });

  test("a machine that never declared one reports nothing to remove", async () => {
    const dir = scratch();
    const outcome = await removeRedwallHook(desktop, {
      configPath: `${dir}/config.yaml`,
      binary: BINARY,
      unitDir: `${dir}/units`,
      run: recorder().run,
    });
    expect(outcome.action).toBe("absent");
    expect(outcome.removed).toEqual([]);
  });

  test("and a server is silent about a feature it could never have held", async () => {
    const said = await saidWhile(async () => {
      const outcome = await removeRedwallHook(server, { configPath: "/nowhere/config.yaml" });
      expect(outcome.action).toBe("absent");
      expect(outcome.skipped).toBe("headless");
    });
    expect(said).toBe("");
  });
});

describe("the argv the daemon is handed", () => {
  test("is two words on a target that can take them", () => {
    expect(redwallHookArgv(desktop, BINARY, null)).toEqual([BINARY, "redwall"]);
    expect(redwallHookArgv(wsl, BINARY, null)).toEqual([BINARY, "redwall"]);
  });

  test("goes through the hidden runner on Windows, so nothing flashes", () => {
    // red-dev.exe is a console program, and a console program started by
    // a process with no console of its own gets a fresh one allocated —
    // a black rectangle on the desktop, now once per Worker.
    expect(redwallHookArgv(windows, "C:\\bin\\red-dev.exe", "C:\\images\\hidden-run.vbs")).toEqual([
      "wscript.exe",
      "//B",
      "//Nologo",
      "C:\\images\\hidden-run.vbs",
      '"C:\\bin\\red-dev.exe" redwall',
    ]);
  });

  test("and falls back to the plain one when the runner cannot be made", () => {
    // A Redwall that repaints with a flash beats one that never repaints.
    expect(redwallHookArgv(windows, "C:\\bin\\red-dev.exe", null)).toEqual([
      "C:\\bin\\red-dev.exe",
      "redwall",
    ]);
  });

  test("a Windows path survives being written and read back as YAML", () => {
    const block = redwallHookBlock(["C:\\Users\\First Last\\red-dev.exe", "redwall"], 0);
    // Double-quoted YAML takes JSON's escapes, which is the whole reason
    // the argv is written in flow style with JSON.stringify.
    expect(block.join("\n")).toContain('argv: ["C:\\\\Users\\\\First Last\\\\red-dev.exe", "redwall"]');
  });
});
