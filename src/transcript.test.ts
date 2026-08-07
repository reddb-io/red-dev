/**
 * The run, written down.
 *
 * Two properties carry this feature and both are easy to break by
 * accident:
 *
 *   1. It is a TEE. log.ts already has `buffer` and `stream`, and each
 *      takes routing away from the console and from each other. A
 *      transcript that behaved like a third sink would blank the
 *      fullscreen view — which is the exact run worth transcribing.
 *
 *   2. logIsCaptured() must NOT count it. That function answers "would a
 *      child writing to the console damage a frame", and if a transcript
 *      flipped it to true, every child would start piping and lose its
 *      progress bar and its ability to prompt for a password.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { captureTo, log, logIsCaptured, transcribeTo } from "./log.ts";
import { prunable, transcriptDir, transcriptName } from "./transcript.ts";

const releases: (() => void)[] = [];
const track = (r: () => void): void => void releases.push(r);
afterEach(() => {
  while (releases.length > 0) releases.pop()?.();
});

describe("the tee", () => {
  test("sees a line that also went to the console", () => {
    const seen: string[] = [];
    track(transcribeTo((l) => seen.push(l)));
    log.ok("hello");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain("hello");
  });

  test("and a line that a fullscreen view claimed", () => {
    // The property the whole design turns on. captureTo redirects to the
    // frame; the transcript must still get the line, or every converge
    // worth reading afterwards is the one that logs nothing.
    const file: string[] = [];
    const frame: string[] = [];
    track(transcribeTo((l) => file.push(l)));
    track(captureTo((l) => frame.push(l)));
    log.err("boom");
    expect(frame).toHaveLength(1);
    expect(file).toHaveLength(1);
  });

  test("does not make logIsCaptured true", () => {
    // If it did, spawnLogged would start piping every child — losing
    // apt's progress bar and sudo's prompt — to write a nicer log file.
    expect(logIsCaptured()).toBe(false);
    track(transcribeTo(() => {}));
    expect(logIsCaptured()).toBe(false);
  });

  test("a throwing sink never breaks the thing being logged", () => {
    // A full disk mid-converge stops the transcript, not the converge.
    track(
      transcribeTo(() => {
        throw new Error("disk full");
      }),
    );
    expect(() => log.ok("still fine")).not.toThrow();
  });

  test("restores the previous tee, so nesting cannot orphan one", () => {
    const outer: string[] = [];
    const release = transcribeTo((l) => outer.push(l));
    const inner: string[] = [];
    transcribeTo((l) => inner.push(l))();
    log.ok("after");
    expect(outer).toHaveLength(1);
    expect(inner).toHaveLength(0);
    release();
  });
});

describe("transcriptName", () => {
  const at = new Date("2026-08-07T09:42:39.212Z");

  test("carries no colon, because NTFS forbids them", () => {
    // An ISO timestamp as-is fails on Windows and works on Linux, which
    // is the worst way to discover a filename bug.
    const name = transcriptName(at, "install core");
    expect(name).not.toContain(":");
    expect(name).toMatch(/^2026-08-07T09-42-39-212-install-core\.log$/);
  });

  test("sorts chronologically as a string", () => {
    const earlier = transcriptName(new Date("2026-08-07T09:00:00.000Z"), "a");
    const later = transcriptName(new Date("2026-08-07T10:00:00.000Z"), "a");
    expect([later, earlier].sort()).toEqual([earlier, later]);
  });

  test("survives a command full of punctuation", () => {
    expect(transcriptName(at, "theme --opacity=90")).toMatch(/-theme-opacity-90\.log$/);
  });

  test("and one that is empty", () => {
    expect(transcriptName(at, "")).toMatch(/-run\.log$/);
  });
});

describe("rotation", () => {
  const names = Array.from({ length: 25 }, (_, i) => `2026-08-07T00-00-${String(i).padStart(2, "0")}-x.log`);

  test("keeps the newest and lists the rest", () => {
    const gone = prunable(names, 20);
    expect(gone).toHaveLength(5);
    expect(gone[0]).toContain("00-00-00");
    expect(gone).not.toContain(names[24]);
  });

  test("removes nothing below the limit", () => {
    expect(prunable(names.slice(0, 5), 20)).toEqual([]);
  });

  test("ignores anything that is not a log", () => {
    // The directory is XDG state and red-dev is not its only possible
    // occupant; deleting a neighbour's file would be a real bug.
    expect(prunable(["notes.txt", "a.log"], 0)).toEqual(["a.log"]);
  });
});

describe("where transcripts go", () => {
  test("XDG_STATE_HOME when the platform has one", () => {
    expect(transcriptDir({ XDG_STATE_HOME: "/x/state", HOME: "/home/me" })).toBe("/x/state/red-dev");
  });

  test("falls back to ~/.local/state, which is the XDG default", () => {
    expect(transcriptDir({ HOME: "/home/me" })).toBe("/home/me/.local/state/red-dev");
  });

  test("LOCALAPPDATA on native Windows", () => {
    // Per-machine and non-roaming, the same reasoning the wallpapers use.
    expect(transcriptDir({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
      "C:/Users/me/AppData/Local/red-dev/logs",
    );
  });

  test("but HOME wins under WSL, where both are set", () => {
    // Inside the distro LOCALAPPDATA can be inherited across the
    // boundary; writing the distro's logs onto the Windows side would
    // interleave two machines' stories in one directory.
    expect(transcriptDir({ LOCALAPPDATA: "C:\\x", HOME: "/home/me" })).toBe(
      "/home/me/.local/state/red-dev",
    );
  });
});
