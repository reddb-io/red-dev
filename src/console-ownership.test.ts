/**
 * Who is allowed to write to the console, and who has to go through the log.
 *
 * The fullscreen views — the setup wizard, the converge, the menu — own
 * the screen and repaint it. `captureTo` redirects `log` into content
 * they can draw, which is what makes running a command without leaving
 * the frame possible at all. A child process spawned with stdout
 * inherited does not participate in any of that: it writes into whatever
 * cell the cursor happens to be in, and the frame tears.
 *
 * The symptom is two streams sharing a row —
 *
 *     Fou ok  Codex CLI[OpenAI.Codex] Version 0.146.1
 *     No fail T3 Code: cmd.exe exited non-zeroes it grant any licenses
 *
 * — winget's "Found"/"No" landing on top of red-dev's "ok"/"fail", plus
 * a progress bar drawn through the panel on the right.
 *
 * `spawnLogged` is the answer and almost everything used it: inherit
 * when nothing is capturing, pipe into the log when something is. The
 * bug was one file with its own copy of the wrong half.
 *
 * This test is a source scan rather than a behavioural one because the
 * failure needs a real console, a real winget and a real frame. What it
 * can do is make the exception list explicit, so the next `inherit`
 * arrives as a failing test with somewhere to write down why.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";

/**
 * Files allowed to inherit the console, and the reason each one is.
 *
 * Adding an entry here is a decision, not a formality: it means "this
 * can never run while a fullscreen view is up", and that has to be true.
 */
const ALLOWED = new Map<string, string>([
  [
    "providers.ts",
    "spawnLogged itself. This is the uncaptured branch — the one that decides to inherit, having checked that nothing is capturing.",
  ],
  [
    "uninstall.ts",
    "`red-dev uninstall` is a plain command with no fullscreen view; it prints a plan and asks at the terminal.",
  ],
  [
    "wsl-provision.ts",
    "`wsl --install` and `--set-version` prompt for a UNIX username and take minutes. They need real stdin, which spawnLogged's captured branch sets to ignore — so routing them through it would hang rather than tear. Known gap: reachable from the TUI menu, where it WOULD tear. Not fixed here because the fix is to refuse the capture, not to pipe it.",
  ],
]);

describe("console ownership", () => {
  const dir = import.meta.dir;
  const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  test("nothing new inherits the console behind a fullscreen view", () => {
    const offenders = sources.filter(
      (f) => !ALLOWED.has(f) && /stdout:\s*"inherit"/.test(readFileSync(`${dir}/${f}`, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("the agent installs go through the log", () => {
    // The regression itself. agents.ts had a private two-line `run` that
    // inherited unconditionally, so every winget and npm agent install
    // painted over the setup wizard that had just asked for them.
    const src = readFileSync(`${dir}/agents.ts`, "utf8");
    expect(src).toContain("spawnLogged");
    expect(src).not.toMatch(/stdout:\s*"inherit"/);
  });

  test("every exception is a file that still exists", () => {
    // An allow-list outliving its file is how a rule quietly stops
    // applying to the thing it was written for.
    for (const name of ALLOWED.keys()) {
      expect(sources, name).toContain(name);
    }
  });

  test("the non-interactive WSL default command goes through the captured log", () => {
    const src = readFileSync(`${dir}/wsl-provision.ts`, "utf8");
    const start = src.indexOf("export async function setWsl2Default");
    const end = src.indexOf("export async function convertDistroToWsl2", start);
    const body = src.slice(start, end);
    expect(body).toContain("spawnLogged");
    expect(body).not.toMatch(/stdout:\s*"inherit"/);
  });
});

describe("the shell that can see the file", () => {
  const src = readFileSync(`${import.meta.dir}/providers.ts`, "utf8");

  test("Windows resolves bash by absolute path, not through PATH", () => {
    // `bash` on a Windows PATH is usually C:\Windows\System32\bash.exe —
    // the WSL launcher, which runs inside the distro. Handed a script
    // under %LOCALAPPDATA%\Temp it reported
    //
    //   /bin/bash: C:/Users/.../red-dev-installer-N.sh: No such file
    //
    // which reads like the temp path being wrong a second time. It was
    // not: the file was there and the interpreter was standing in
    // another filesystem.
    expect(src).toContain("windowsShellPath");
    expect(src).toContain("C:\\\\Program Files\\\\Git\\\\bin\\\\");
  });

  test("and says so rather than spawning something doomed", () => {
    expect(src).toContain("there is no Git Bash to run it");
  });
});
