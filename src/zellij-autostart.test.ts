/**
 * The block that turns zellij into the session.
 *
 * This is the riskiest shell red-dev ships: it runs in every interactive
 * shell on every target, and the failure modes are a terminal that opens
 * into nothing and a shell that starts a multiplexer inside a
 * multiplexer forever. Neither shows up in a type check.
 *
 * So it is tested the way it runs — a real bash, a real pty, and a stub
 * on PATH standing in for zellij, which reports whether it was started
 * and with what.
 */

import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";

const SOURCE = `${import.meta.dir}/../config/bash/zellij.sh`;

/**
 * A fake zellij that announces itself and exits with STUB_EXIT.
 *
 * STUB_STDERR stands in for a panic message, which is the only thing the
 * real one writes to stderr on the failure this suite cares about.
 */
function stubDir(): string {
  const dir = mkdtempSync(`${tmpdir()}/red-zellij-stub-`);
  const stub = `${dir}/zellij`;
  writeFileSync(
    stub,
    '#!/bin/sh\necho "STUB RED_IN_ZELLIJ=$RED_IN_ZELLIJ"\n' +
      '[ -n "$STUB_STDERR" ] && echo "$STUB_STDERR" >&2\n' +
      "exit ${STUB_EXIT:-0}\n",
  );
  chmodSync(stub, 0o755);
  return dir;
}

interface Run {
  out: string;
  /** True when execution continued past the sourced file. */
  fellThrough: boolean;
  /** True when the stub was started at all. */
  started: boolean;
  /** XDG_STATE_HOME for this run, where the crash log would be. */
  stateHome: string;
}

/**
 * Source the file in a shell and report what happened after.
 *
 * `interactive` decides between a plain `bash -c`, which is what a
 * script or an agent gets, and a pty-backed interactive bash, which is
 * what a person gets — the guard has to tell those apart, so the test
 * has to produce both.
 */
function run(env: Record<string, string>, interactive: boolean): Run {
  const dir = stubDir();
  // Somewhere to leave a crash log that is not the real one under $HOME.
  const stateHome = mkdtempSync(`${tmpdir()}/red-zellij-state-`);
  const body = `source ${SOURCE}; echo FELLTHROUGH`;
  const argv = interactive
    ? ["script", "-qec", `bash --norc -i -c '${body}'`, "/dev/null"]
    : ["bash", "--norc", "-c", body];

  const proc = Bun.spawnSync(argv, {
    env: {
      ...process.env,
      PATH: `${dir}:${process.env["PATH"]}`,
      // Inherited from whatever ran the test suite, and both would
      // otherwise make every case look like "already inside one".
      ZELLIJ: "",
      ZELLIJ_SESSION_NAME: "",
      RED_IN_ZELLIJ: "",
      TERM: "xterm-256color",
      XDG_STATE_HOME: stateHome,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = (
    new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
  ).replace(/\r/g, "");

  return {
    out,
    fellThrough: out.includes("FELLTHROUGH"),
    started: out.includes("STUB"),
    stateHome,
  };
}

/** The crash logs left behind by a run, newest name first. */
function crashLogs(r: Run): string[] {
  const dir = `${r.stateHome}/red-dev`;
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.startsWith("zellij-") && f.endsWith(".log"));
}

describe("zellij autostart", () => {
  test("starts zellij in an interactive terminal", () => {
    const r = run({}, true);
    expect(r.started).toBe(true);
    // zellij exited 0, so the terminal is done and nothing runs after.
    expect(r.fellThrough).toBe(false);
  });

  test("marks the child so the shell inside it does not start another", () => {
    // The whole recursion guard rests on this variable reaching the
    // pane. Without it, every new pane opens a new zellij, forever.
    expect(run({}, true).out).toContain("STUB RED_IN_ZELLIJ=1");
  });

  test("falls back to a plain shell when zellij cannot start", () => {
    // Not exec, precisely for this: a broken config must not leave
    // someone with a terminal that closes as fast as it opens.
    const r = run({ STUB_EXIT: "3" }, true);
    expect(r.started).toBe(true);
    expect(r.fellThrough).toBe(true);
    expect(r.out).toContain("zellij exited 3");
  });

  /**
   * The fallback shell must not inherit a half-configured terminal.
   *
   * zellij turns these on at startup and off again on its way out. Exit
   * 101 is a Rust panic, which skips the way out entirely, and then the
   * shell below is left with the kitty keyboard protocol still pushed —
   * so Esc arrives as ESC[27u, readline eats the ESC[ and types `27u` on
   * the command line — mouse motion still reported as input, and the
   * alternate buffer still showing the background zellij painted.
   */
  describe("restores the terminal zellij abandoned", () => {
    const undone: [string, string][] = [
      ["kitty keyboard protocol", "[<u"],
      ["alternate screen buffer", "[?1049l"],
      ["mouse motion reporting", "[?1003l"],
      ["SGR mouse encoding", "[?1006l"],
      ["colour scheme notifications", "[?2031l"],
    ];

    for (const [name, seq] of undone) {
      test(name, () => {
        expect(run({ STUB_EXIT: "101" }, true).out).toContain(seq);
      });
    }

    test("and does not touch a terminal it never took", () => {
      // The clean path exits the shell, so nothing is printed after
      // zellij's own cleanup — sending these there would fight it.
      expect(run({}, true).out).not.toContain("[<u");
    });
  });

  describe("the crash log", () => {
    test("keeps what zellij printed on its way out", () => {
      // zellij truncates its own log on the next start, so a panic that
      // is only there is gone by the time anyone looks.
      const r = run({ STUB_EXIT: "101", STUB_STDERR: "thread 'main' panicked at x" }, true);
      const logs = crashLogs(r);
      expect(logs).toHaveLength(1);
      expect(readFileSync(`${r.stateHome}/red-dev/${logs[0]}`, "utf8")).toContain(
        "thread 'main' panicked at x",
      );
      expect(r.out).toContain("what zellij printed on its way out is in");
    });

    test("is not left behind by a session that ended normally", () => {
      expect(crashLogs(run({ STUB_STDERR: "noise" }, true))).toHaveLength(0);
    });

    test("is not left behind by a failure that printed nothing", () => {
      // An empty file is worse than no file: it reads as a crash with no
      // cause rather than as a crash whose cause went somewhere else.
      const r = run({ STUB_EXIT: "1" }, true);
      expect(crashLogs(r)).toHaveLength(0);
      expect(r.out).not.toContain("what zellij printed");
    });
  });

  test("leaves non-interactive shells alone", () => {
    // Scripts, scp, and every `bash -c` an editor or an agent runs.
    const r = run({}, false);
    expect(r.started).toBe(false);
    expect(r.fellThrough).toBe(true);
  });

  describe("does not start a second one when", () => {
    const cases: [string, Record<string, string>][] = [
      ["already inside a zellij pane", { ZELLIJ: "0" }],
      ["inside one by session name", { ZELLIJ_SESSION_NAME: "main" }],
      ["our own marker is set", { RED_IN_ZELLIJ: "1" }],
      ["tmux has the terminal", { TMUX: "/tmp/tmux-1000/default,1,0" }],
      ["turned off by preference", { RED_ZELLIJ: "0" }],
      ["the VS Code terminal", { TERM_PROGRAM: "vscode" }],
      ["a JetBrains terminal", { TERMINAL_EMULATOR: "JetBrains-JediTerm" }],
      ["nvim's :terminal", { NVIM: "/run/nvim.sock" }],
      ["a dumb terminal", { TERM: "dumb" }],
      ["a linux virtual console", { TERM: "linux" }],
    ];

    for (const [name, env] of cases) {
      test(name, () => {
        const r = run(env, true);
        expect(r.started).toBe(false);
        expect(r.fellThrough).toBe(true);
      });
    }
  });
});
