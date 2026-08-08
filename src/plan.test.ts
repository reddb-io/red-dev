/**
 * What `plan` says about administrator, before anything is touched.
 *
 * The run that made this necessary asked for administrator at item 36 of
 * 38, after half an hour of installs — a session that had to be
 * abandoned and started again elevated. The manifest already declares
 * which columns need the rights; this is the command that reads the
 * declaration out loud while it still costs nothing to act on.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { itemsNeedingAdmin, toolsInScope } from "./manifest.ts";
import { administratorNotice } from "./plan.ts";
import type { Capabilities, Platform } from "./platform.ts";

function platform(over: Partial<Platform> = {}): Platform {
  const caps: Capabilities = {
    apt: true,
    gui: false,
    systemd: true,
    winget: false,
    flatpak: false,
    ...(over.caps ?? {}),
  };
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "wsl",
    arch: "x64",
    ...over,
    caps,
  };
}

const WSL24 = platform();
const WSL26 = platform({ version: "26.04", codename: "resolute" });
const DESKTOP = platform({ env: "desktop", caps: { gui: true } as Capabilities });
const SERVER = platform({ env: "server" });
const WINDOWS = platform({
  os: "windows",
  env: "windows",
  distro: null,
  version: null,
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
});

/**
 * Whether the notice names this item.
 *
 * Bounded rather than a plain substring: several manifest items are
 * short enough to appear inside ordinary English — `gh` inside
 * "through", `bat` inside "about", `red` inside "required" — and a
 * check that counts those reports whatever prose the notice happens to
 * carry as an announced item.
 */
function names(notice: string[], name: string): boolean {
  return new RegExp(`\\b${name}\\b`).test(notice.join("\n"));
}

describe("the plan's administrator announcement", () => {
  test("a Windows target names every declared privileged item", () => {
    const notice = administratorNotice(WINDOWS);
    const declared = itemsNeedingAdmin(WINDOWS).map((t) => t.name);
    expect(declared.length).toBeGreaterThan(0);
    for (const name of declared) expect([name, names(notice, name)]).toEqual([name, true]);
  });

  test("a Linux target names none", () => {
    // Silence rather than "nothing needs administrator", because on
    // Ubuntu the word means the wrong thing: privileged work there goes
    // through sudo, a path that already works and must not be disturbed
    // by a line inviting someone to look for elevation that has no
    // equivalent here.
    for (const p of [WSL24, WSL26, DESKTOP, SERVER]) {
      expect(administratorNotice(p)).toEqual([]);
    }
  });

  test("an item that does not need administrator is not named", () => {
    // The half that catches a notice which simply lists the plan: every
    // other item in scope has to be absent from it, or the operator
    // learns nothing from reading it.
    const notice = administratorNotice(WINDOWS);
    const named = new Set(itemsNeedingAdmin(WINDOWS).map((t) => t.name));
    const others = toolsInScope("core")
      .map((t) => t.name)
      .filter((name) => !named.has(name));
    expect(others.length).toBeGreaterThan(0);
    for (const name of others) expect([name, names(notice, name)]).toEqual([name, false]);
  });

  test("it says what to do about it", () => {
    // Naming the items is only half an answer. The point of announcing
    // early is that an elevated session is still a cheap decision, so
    // the notice has to say that is the move.
    expect(administratorNotice(WINDOWS).join("\n")).toContain("elevated");
  });

  test("it answers for the scope being planned", () => {
    // `plan wsl` must not announce a core item nobody asked about, and
    // must not hide one it did.
    expect(administratorNotice(WINDOWS, ["desktop"])).toEqual([]);
    expect(administratorNotice(WINDOWS, ["core"]).join("\n")).toContain("ssh-server");
  });

  test("the plan still changes nothing", () => {
    // The answer above was produced for a Windows target by a test
    // running on Linux, which is only possible because it comes from
    // the declarations alone. Pinned at the source too: a notice that
    // reached for the host — probing a service, asking PowerShell
    // whether the session is elevated — would turn `plan` into
    // something that runs, and would stop working on the machine that
    // most needs to read it before committing to the install.
    const source = readFileSync("src/plan.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/node:(fs|child_process|os)/);
    expect(source).not.toMatch(/spawn|exec|writeFile|readFile/);
  });
});
