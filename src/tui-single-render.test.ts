/**
 * One render per process, on the path the interface actually takes.
 *
 * The crash that motivated this had a stack and no reproduction:
 *
 *     Error: EPIPE: broken pipe, write
 *         at dispose → initializeApp → render → runInstallTui → cmdUi
 *
 * Picking Install from the fullscreen menu left the first app and
 * started a second one; on Windows that second initialisation failed and
 * its own cleanup wrote to a stdout that was already gone, which killed
 * the process and closed the console with it. Three synthetic
 * experiments — two sequential renders, exit() from inside a key
 * handler, heavy output after teardown — all survived in a real Windows
 * console, so the shape was only visible in the real path.
 *
 * Structural rather than behavioural because the failure needs a real
 * Windows console and a keystroke, which no test here has. What it can
 * do is fail the moment the second render comes back.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(p, "utf8");

describe("the fullscreen path", () => {
  test("cmdUi does not start a second render", () => {
    const main = read("src/main.ts");
    const cmdUi = main.slice(main.indexOf("async function cmdUi"));
    const body = cmdUi.slice(0, cmdUi.indexOf("\n}\n"));
    expect(body).not.toContain("runInstallTui");
    // It hands the converge in instead.
    expect(body).toContain("runTui(p, {");
  });

  test("the menu hosts the converge rather than returning to it", () => {
    const tui = read("src/tui.ts");
    expect(tui).toContain("InstallLayout");
    expect(tui).toContain("useInstallModel");
    // One render call, and it is the only one in this file.
    expect(tui.match(/\brender\(App/g) ?? []).toHaveLength(1);
  });

  test("runInstallTui remains, for `red-dev install` on its own", () => {
    // That path is a first render, which was never the problem — and
    // deleting it would drop the live view from the plain command.
    const install = read("src/tui-install.ts");
    expect(install).toContain("export async function runInstallTui");
    expect(install.match(/\brender\(App/g) ?? []).toHaveLength(1);
  });

  test("the model's hooks are not called behind a condition", () => {
    // A hook inside an `if` changes the hook order between frames, which
    // is why the model is built on every frame and only `begin()` is
    // conditional.
    const tui = read("src/tui.ts");
    const call = tui.indexOf("useInstallModel(install");
    expect(call).toBeGreaterThan(-1);
    // The guard is a ternary on a value fixed for the process, not on
    // anything that changes while it runs.
    expect(tui.slice(call - 60, call)).toContain("install");
  });
});
