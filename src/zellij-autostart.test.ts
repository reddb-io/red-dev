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
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";

const SOURCE = `${import.meta.dir}/../config/bash/zellij.sh`;

/** A fake zellij that announces itself and exits with STUB_EXIT. */
function stubDir(): string {
  const dir = mkdtempSync(`${tmpdir()}/red-zellij-stub-`);
  const stub = `${dir}/zellij`;
  writeFileSync(
    stub,
    '#!/bin/sh\necho "STUB RED_IN_ZELLIJ=$RED_IN_ZELLIJ"\nexit ${STUB_EXIT:-0}\n',
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
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const out = (
    new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr)
  ).replace(/\r/g, "");

  return { out, fellThrough: out.includes("FELLTHROUGH"), started: out.includes("STUB") };
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
