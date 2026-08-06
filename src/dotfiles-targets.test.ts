/**
 * A Windows machine running WSL has two homes, and the shell config is
 * the pair that drifts without anything failing.
 *
 * Converging from inside the distro wrote the distro's copy only, so the
 * Git Bash side kept whatever it had from the last time red-dev ran as a
 * native Windows binary. On the machine this was written for that was
 * eight days of skew, with a prompt.sh still missing the TERM=dumb
 * guard: the mode you were not in was quietly older, and `doctor` had
 * nothing to say about it because the side it looked at was correct.
 */

import { describe, expect, test } from "bun:test";
import { deployTargets } from "./dotfiles.ts";

const WSL_HOME = "/home/cyber";
const WIN_HOME = "/mnt/c/Users/filip";

describe("deployTargets", () => {
  test("from the distro, both homes are written", () => {
    const t = deployTargets("wsl", WSL_HOME, WIN_HOME);
    expect(t.map((x) => x.dir)).toEqual([WSL_HOME, WIN_HOME]);
  });

  test("the distro's own home comes first", () => {
    // If the crossing fails halfway, the side the user is actually in
    // has already been converged.
    expect(deployTargets("wsl", WSL_HOME, WIN_HOME)[0]?.dir).toBe(WSL_HOME);
  });

  test("an unreachable Windows profile leaves one target, not an error", () => {
    // Interop switched off, or a C: that did not mount. That machine has
    // no second home to converge; it is not a broken install of the
    // first one.
    expect(deployTargets("wsl", WSL_HOME, null)).toHaveLength(1);
  });

  test("native Windows writes only its own home", () => {
    // Its distro is reached by wsl-sync, which runs a full install in
    // there rather than reaching into its filesystem. Writing both from
    // here would be the same crossing owned by two different steps.
    expect(deployTargets("windows", "C:/Users/filip", WIN_HOME)).toHaveLength(1);
  });

  test("a Linux desktop has no other side", () => {
    expect(deployTargets("desktop", WSL_HOME, null)).toHaveLength(1);
    expect(deployTargets("server", WSL_HOME, null)).toHaveLength(1);
  });

  test("the same directory twice is one target", () => {
    // Guards a %USERPROFILE% that resolves back to where we already
    // wrote: the second pass would re-read and re-hook the same
    // .bashrc, and the backup would be of our own edit.
    expect(deployTargets("wsl", WIN_HOME, WIN_HOME)).toHaveLength(1);
  });
});
