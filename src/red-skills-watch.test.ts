/**
 * Asking often costs nothing; taking happens once.
 *
 * ADR 0017 makes a new release something the machine takes rather than
 * something a person remembers to fetch. What has to hold for that to
 * be safe rather than merely fast: the network is asked at most once
 * per interval however many triggers fire, two triggers at once are one
 * acquisition, and a failed ask does not silence the next one.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isDue,
  lastAskedAt,
  releaseWatchLock,
  takeWatchLock,
  WATCH_INTERVAL_MS,
  watchRedSkills,
  watchStampPath,
  type WatchResult,
  windowsRedDevCandidates,
} from "./red-skills-watch.ts";

function home(): string {
  return mkdtempSync(join(tmpdir(), "red-watch-"));
}

const took: WatchResult = { outcome: "took", reason: "acquired 4.0.2" };

describe("the interval", () => {
  test("a machine that has never asked is due", () => {
    expect(isDue(null, 1_000_000)).toBe(true);
  });

  test("inside it, nothing is asked", () => {
    expect(isDue(1_000_000, 1_000_000 + WATCH_INTERVAL_MS - 1)).toBe(false);
    expect(isDue(1_000_000, 1_000_000 + WATCH_INTERVAL_MS)).toBe(true);
  });

  test("a stamp from the future is a clock that moved, not a fresh answer", () => {
    // Two machines sharing a home across a boundary, or a laptop whose
    // clock jumped. Treating it as fresh would freeze the watch until
    // real time caught up with the stamp.
    expect(isDue(2_000_000, 1_000_000)).toBe(true);
  });
});

describe("the lock", () => {
  test("one holder at a time, and the second is told rather than queued", () => {
    const path = join(home(), "watch.json");
    const first = takeWatchLock(path, 1_000);
    expect(first).not.toBeNull();
    expect(takeWatchLock(path, 1_000)).toBeNull();
    releaseWatchLock(path, first!);
    const again = takeWatchLock(path, 1_000);
    expect(again).not.toBeNull();
    releaseWatchLock(path, again!);
  });

  test("a lock left by a killed process expires, so a crash cannot lock a machine out", () => {
    const path = join(home(), "watch.json");
    const held = takeWatchLock(path, Date.now());
    expect(held).not.toBeNull();

    // Aged on the filesystem rather than by lying about the clock: the
    // staleness is a comparison against the lock's own mtime, so this
    // exercises the real mechanism.
    const old = Date.now() - 11 * 60 * 1000;
    utimesSync(`${path}.lock`, new Date(old), new Date(old));

    const later = takeWatchLock(path, Date.now());
    expect(later).not.toBeNull();
    releaseWatchLock(path, later!);
  });

  test("is released even when the take throws", async () => {
    const h = home();
    await expect(
      watchRedSkills({
        home: h,
        nowMs: 1_000,
        take: () => Promise.reject(new Error("boom")),
      }),
    ).rejects.toThrow("boom");
    // Not still held: the next run must be able to take it.
    const path = watchStampPath(h);
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe("a watch run", () => {
  test("takes what is there and records that it asked", async () => {
    const h = home();
    const result = await watchRedSkills({ home: h, nowMs: 5_000, take: async () => took });
    expect(result).toEqual(took);
    expect(lastAskedAt(watchStampPath(h))).toBe(5_000);
  });

  test("a second trigger inside the interval asks nothing at all", async () => {
    const h = home();
    let asks = 0;
    const take = async (): Promise<WatchResult> => {
      asks++;
      return took;
    };

    await watchRedSkills({ home: h, nowMs: 5_000, take });
    const second = await watchRedSkills({ home: h, nowMs: 5_000 + 60_000, take });

    expect(second.outcome).toBe("not-due");
    expect(asks).toBe(1);
  });

  test("a person typing the command means now, whatever the stamp says", async () => {
    const h = home();
    let asks = 0;
    const take = async (): Promise<WatchResult> => {
      asks++;
      return took;
    };
    await watchRedSkills({ home: h, nowMs: 5_000, take });
    await watchRedSkills({ home: h, nowMs: 5_100, take, force: true });
    expect(asks).toBe(2);
  });

  test("a publisher that could not be reached does not silence the next trigger", async () => {
    // Fifteen minutes of silence bought with a failure is fifteen
    // minutes a machine stays behind for no reason.
    const h = home();
    const result = await watchRedSkills({
      home: h,
      nowMs: 5_000,
      take: async () => ({ outcome: "unreachable", reason: "no network" }),
    });
    expect(result.outcome).toBe("unreachable");
    expect(lastAskedAt(watchStampPath(h))).toBeNull();
  });

  test("an unreadable stamp is treated as never asked, not as an error", () => {
    const h = home();
    const broken = join(h, "broken.json");
    writeFileSync(broken, "{ not json");
    expect(lastAskedAt(broken)).toBeNull();
    expect(lastAskedAt(join(h, "absent.json"))).toBeNull();
  });

  test("what it found is written down, for a person reading the file", async () => {
    const h = home();
    await watchRedSkills({ home: h, nowMs: 7_000, take: async () => took });
    const stamp = JSON.parse(readFileSync(watchStampPath(h), "utf8")) as Record<string, unknown>;
    expect(stamp["found"]).toBe("acquired 4.0.2");
    expect(stamp["askedAtMs"]).toBe(7_000);
  });

  test("a machine already current writes no news, only the time", async () => {
    const h = home();
    await watchRedSkills({
      home: h,
      nowMs: 9_000,
      take: async () => ({ outcome: "current", reason: "already on e0dea94" }),
    });
    const stamp = JSON.parse(readFileSync(watchStampPath(h), "utf8")) as Record<string, unknown>;
    expect(stamp["found"]).toBeUndefined();
  });
});

describe("the trigger in the shell", () => {
  test("hangs off the prompt, which is the event that happens while somebody works", async () => {
    // It used to fire once at shell start, and a terminal opened in the
    // morning and kept all day never asked again: measured at 107
    // minutes behind, one release stale, with the shell open the whole
    // time. A prompt is a person; a shell start is a person once.
    const source = await Bun.file(
      new URL("../config/bash/red-skills-watch.sh", import.meta.url),
    ).text();

    expect(source).toContain("PROMPT_COMMAND");
    // Appended, never replacing: `history -a` and whatever the operator
    // set for themselves both have to keep running.
    expect(source).toContain('PROMPT_COMMAND="_red_skills_watch_tick${PROMPT_COMMAND:+; $PROMPT_COMMAND}"');
    // And installed once, however many times the profile is sourced.
    expect(source).toContain("*_red_skills_watch_tick*");
  });

  test("costs no fork per prompt, which is the whole reason it can be there", async () => {
    const source = await Bun.file(
      new URL("../config/bash/red-skills-watch.sh", import.meta.url),
    ).text();
    const tick = source.slice(source.indexOf("_red_skills_watch_tick() {"));

    // $EPOCHSECONDS is a bash builtin. `date` or `stat` here would be a
    // process per prompt, which is the timer this design refuses,
    // wearing a different hat.
    expect(tick).toContain("EPOCHSECONDS");
    expect(tick).not.toContain("$(date");
    expect(tick).not.toContain("$(stat");
    // The guard returns before anything is spawned.
    expect(tick.indexOf("return 0")).toBeLessThan(tick.indexOf("red-dev red-skills watch"));
  });

  test("is detached, interactive-only, and off when RED_SKILLS_WATCH=0", async () => {
    const source = await Bun.file(
      new URL("../config/bash/red-skills-watch.sh", import.meta.url),
    ).text();

    // Nothing may wait for it: a shell that started while the publisher
    // was unreachable is a shell that started.
    expect(source).toContain(">/dev/null 2>&1 &");
    // A script or a hook sourcing the profile has not asked for
    // background work, and a non-interactive shell that spawns one is
    // how a converge races itself.
    expect(source).toContain('case "$-" in');
    expect(source).toContain("*i*");
    expect(source).toContain("RED_SKILLS_WATCH:-1");
    // `due` and not a bare `watch`: a shell is not a person typing.
    expect(source).toContain("red-skills watch due");
    // And it never runs where red-dev is not on PATH yet.
    expect(source).toContain("command -v red-dev");
  });

  test("is sourced after path.sh, which is what puts red-dev on PATH", async () => {
    const rc = await Bun.file(new URL("../config/bash/rc.sh", import.meta.url)).text();
    const order = rc.match(/for _red_part in ([^;]+);/)?.[1]?.split(/\s+/) ?? [];
    expect(order).toContain("red-skills-watch");
    expect(order.indexOf("red-skills-watch")).toBeGreaterThan(order.indexOf("path"));
  });

  test("ships in the binary, or a converge deploys a file that does not exist", async () => {
    const { FILES } = await import("./dotfiles.ts");
    expect(Object.keys(FILES)).toContain("red-skills-watch.sh");
    expect(FILES["red-skills-watch.sh"]).toContain("red-skills watch due");
  });
});

describe("the other half of a WSL machine", () => {
  test("is asked too, whatever this half found", async () => {
    // Two roots, two package sets, two red-devs. The distro's watch
    // moves the distro and nothing else, and the Windows half has no
    // trigger of its own: PowerShell reads no bash profile, and the
    // daemon's host hook execs inside the distro.
    const h = home();
    const crossed: string[] = [];
    await watchRedSkills({
      home: h,
      nowMs: 1_000,
      take: async () => ({ outcome: "current", reason: "already on e0dea94" }),
      manifestPlatform: { env: "wsl" } as never,
      cross: async () => {
        crossed.push("kicked");
        return { outcome: "kicked" as const, reason: "asked C:\\red-dev.exe" };
      },
    });
    // Current on this side says nothing about the other one.
    expect(crossed).toEqual(["kicked"]);
  });

  test("is not asked from a machine that has no other half", async () => {
    const h = home();
    let crossed = 0;
    await watchRedSkills({
      home: h,
      nowMs: 1_000,
      take: async () => took,
      cross: async () => {
        crossed++;
        return { outcome: "kicked" as const, reason: "asked C:\\red-dev.exe" };
      },
    });
    // No platform, no crossing: a plain Linux machine is one machine.
    expect(crossed).toBe(0);
  });

  test("crosses through the hidden runner, because red-dev.exe is a console program", async () => {
    const source = await Bun.file(new URL("./red-skills-watch.ts", import.meta.url)).text();
    const fn = source.slice(source.indexOf("export async function crossToWindows"));
    // Through wscriptBin() rather than the bare name: the crossing runs
    // from a systemd service too, whose PATH carries no /mnt/c at all,
    // and the bare spawn reported `wscript could not start` there while
    // the same code worked from a shell.
    expect(fn).toContain("wscriptBin()");
    expect(fn).not.toContain('["wscript.exe"');
    expect(fn).toContain("//B");
    expect(fn).toContain("hiddenRunnerPath");
    // Never `windowsBinDir`: it reads %LOCALAPPDATA%, which a distro
    // does not have — the first version called it, threw, caught itself
    // and reported "skipped", so the crossing never once happened.
    expect(fn).not.toContain("windowsBinDir");
    expect(fn).toContain("windowsRedDevCandidates");
    expect(fn).toContain("windowsLocalAppData");
    // Detached: a shell starting must not wait for a Windows process.
    expect(fn).toContain("proc.unref()");
    // `due`, so the far side's own interval decides.
    expect(fn).toContain("red-skills watch due");
    // Only from inside a distro.
    expect(fn).toContain('p.env !== "wsl"');
  });
});

describe("which red-dev the Windows half is asked through", () => {
  const listing = (names: string[]) => () => names;

  test("mise's newest installed version first, the bootstrap copy last", () => {
    expect(
      windowsRedDevCandidates("/mnt/c/Users/me/AppData/Local", listing(["1.0.9", "1.0.10", "1.0.2"])),
    ).toEqual([
      // Numerically, so 1.0.10 is newer than 1.0.9.
      "/mnt/c/Users/me/AppData/Local/mise/installs/red-dev/1.0.10/red-dev.exe",
      "/mnt/c/Users/me/AppData/Local/mise/installs/red-dev/1.0.9/red-dev.exe",
      "/mnt/c/Users/me/AppData/Local/mise/installs/red-dev/1.0.2/red-dev.exe",
      "/mnt/c/Users/me/AppData/Local/red-dev/bin/red-dev.exe",
    ]);
  });

  test("never the shim: mise cannot re-enter itself from inside a distro", () => {
    // The first crossing asked the shim. wscript started, mise answered
    // `mise ERROR Version:`, and nothing on the far side ever moved —
    // a kick that was sent and did nothing, which is the worst kind.
    const all = windowsRedDevCandidates("/mnt/c/Users/me/AppData/Local", listing(["1.0.10"]));
    for (const path of all) expect(path).not.toContain("/shims/");
  });

  test("selector links are not versions, because they move", () => {
    const all = windowsRedDevCandidates(
      "/mnt/c/Users/me/AppData/Local",
      listing(["1", "1.0", "latest", "1.0.10"]),
    );
    expect(all.filter((p) => p.includes("/installs/"))).toEqual([
      "/mnt/c/Users/me/AppData/Local/mise/installs/red-dev/1.0.10/red-dev.exe",
    ]);
  });

  test("a Windows side mise never touched still answers with the bootstrap copy", () => {
    expect(windowsRedDevCandidates("/mnt/c/Users/me/AppData/Local/", listing([]))).toEqual([
      "/mnt/c/Users/me/AppData/Local/red-dev/bin/red-dev.exe",
    ]);
  });

  test("a skip says why, because a silent one is how this stayed broken", async () => {
    const { crossToWindows } = await import("./red-skills-watch.ts");
    const onLinux = await crossToWindows({ env: "desktop" } as never);
    expect(onLinux.outcome).toBe("skipped");
    expect(onLinux.reason).toContain("nothing to cross to");
  });
});

describe("a release that is still uploading", () => {
  test("is asked again in a minute, not in fifteen", async () => {
    // A GitHub release exists before its assets do. Measured: v4.0.12
    // was created at 16:40:53 and had 2 of its 39 assets a minute
    // later, and the person who asked in that window was told it
    // "publishes no package-set.manifest.json" and then waited a
    // quarter of an hour for the machine to look again.
    const h = home();
    const now = 10_000_000;
    await watchRedSkills({
      home: h,
      nowMs: now,
      take: async () => ({
        outcome: "refused",
        reason: "release v4.0.12 publishes no package-set.manifest.json",
      }),
    });

    // Due again a minute later, not fifteen.
    const last = lastAskedAt(watchStampPath(h));
    expect(isDue(last, now + 59_000)).toBe(false);
    expect(isDue(last, now + 61_000)).toBe(true);
  });

  test("an ordinary refusal still stands for the whole interval", async () => {
    // A signature that did not verify is not a matter of timing, and
    // asking again in a minute would be a machine retrying a refusal.
    const h = home();
    const now = 10_000_000;
    await watchRedSkills({
      home: h,
      nowMs: now,
      take: async () => ({ outcome: "refused", reason: "manifest signature is invalid" }),
    });

    const last = lastAskedAt(watchStampPath(h));
    expect(isDue(last, now + 61_000)).toBe(false);
  });
});

describe("how the crossing carries its command", () => {
  test("through a .cmd file, because quotes do not survive the trip", async () => {
    // Three attempts failed the same way and looked like three
    // different bugs. The argument used to be one string carrying
    // quotes — `"C:\...\red-dev.exe" red-skills watch due` — and what
    // arrived on the far side was a literal \"C:\...\red-dev.exe\",
    // which the shell reported as a command it did not recognise. The
    // kick was sent, wscript started, and nothing ever ran.
    const source = await Bun.file(new URL("./red-skills-watch.ts", import.meta.url)).text();
    const fn = source.slice(source.indexOf("export async function crossToWindows"));

    expect(fn).toContain("red-skills-watch.cmd");
    // The argument handed to wscript carries no quotes of its own.
    expect(fn).not.toContain('`"${binary}" red-skills watch due`');
    // And the quoting lives in the file, where nothing can mangle it.
    expect(fn).toContain('@echo off');
    expect(fn).toContain('"${binary}" red-skills watch due');
  });

  test("the wrapper is a Windows batch file, CRLF and all", async () => {
    const source = await Bun.file(new URL("./red-skills-watch.ts", import.meta.url)).text();
    expect(source.slice(source.indexOf("export async function crossToWindows"))).toContain("\\r\\n");
  });
});
