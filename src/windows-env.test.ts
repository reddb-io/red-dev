/**
 * Remembering what Windows answered, and knowing when to stop.
 *
 * The cost being avoided is not the milliseconds. Asking the host for
 * %APPDATA% from inside WSL means a `cmd.exe` through interop, and a
 * console program started that way by a process with no console of its
 * own — the Redwall's systemd timer — has a window allocated for it. One
 * tick used to ask twice over, three times each.
 *
 * So `asked` is counted in every test here: the subject is how many
 * times the host is disturbed, and nothing else would show it.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "bun:test";
import {
  forgetWindowsDirs,
  parseWindowsEnvRecord,
  rememberedWindowsDir,
  windowsEnvRecord,
} from "./windows-env.ts";

/**
 * A machine with an empty cache, and the memo cleared with it.
 *
 * Both halves, because the memo outlives a temporary HOME: a test that
 * only moved the directory would be answered by whatever the test before
 * it had asked for.
 */
async function onFreshMachine<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-windows-env-`);
  process.env["HOME"] = home;
  forgetWindowsDirs();
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

afterEach(() => forgetWindowsDirs());

/** A host that answers with a real directory and counts being asked. */
function host(answer: string) {
  const asked: number[] = [];
  return {
    get count() {
      return asked.length;
    },
    ask: async () => {
      asked.push(1);
      return answer;
    },
  };
}

describe("asking the host", () => {
  test("happens once and is answered from the record after that", async () => {
    await onFreshMachine(async (home) => {
      const windows = host(home);

      expect(await rememberedWindowsDir("LOCALAPPDATA", windows.ask)).toBe(home);
      forgetWindowsDirs();
      expect(await rememberedWindowsDir("LOCALAPPDATA", windows.ask)).toBe(home);

      // The memo was cleared between them, so the second answer came off
      // the disk — which is the run that matters, because every tick of
      // the timer is a new process.
      expect(windows.count).toBe(1);
      expect(existsSync(`${home}/.cache/red-dev/windows-env`)).toBe(true);
    });
  });

  test("happens once per process even before anything is written", async () => {
    await onFreshMachine(async (home) => {
      const windows = host(home);

      await rememberedWindowsDir("APPDATA", windows.ask);
      await rememberedWindowsDir("APPDATA", windows.ask);
      await rememberedWindowsDir("APPDATA", windows.ask);

      // A converge reaches `readPreferences` from several unrelated
      // places, and none of them should have to know another already
      // paid for the answer.
      expect(windows.count).toBe(1);
    });
  });

  test("keeps both answers, so one does not cost the other its record", async () => {
    await onFreshMachine(async (home) => {
      const roaming = host(home);
      const local = host(tmpdir());

      await rememberedWindowsDir("APPDATA", roaming.ask);
      await rememberedWindowsDir("LOCALAPPDATA", local.ask);
      forgetWindowsDirs();
      await rememberedWindowsDir("APPDATA", roaming.ask);

      expect(roaming.count).toBe(1);
      expect(local.count).toBe(1);
    });
  });

  test("happens again when the recorded directory is not there any more", async () => {
    // The whole of the staleness check, and it is enough: a profile
    // moved, a drive re-lettered, the record copied from another machine
    // all end at a path that does not resolve.
    await onFreshMachine(async (home) => {
      await Bun.write(
        `${home}/.cache/red-dev/windows-env`,
        windowsEnvRecord({ LOCALAPPDATA: `${home}/gone` }),
      );
      const windows = host(home);

      expect(await rememberedWindowsDir("LOCALAPPDATA", windows.ask)).toBe(home);

      expect(windows.count).toBe(1);
      // And the record now says what the host said, so the next process
      // does not pay for the same discovery.
      expect(
        parseWindowsEnvRecord(await Bun.file(`${home}/.cache/red-dev/windows-env`).text()),
      ).toEqual({ LOCALAPPDATA: home });
    });
  });

  test("happens again when the record is a file rather than a directory", async () => {
    await onFreshMachine(async (home) => {
      const decoy = `${home}/not-a-directory`;
      writeFileSync(decoy, "");
      await Bun.write(`${home}/.cache/red-dev/windows-env`, windowsEnvRecord({ APPDATA: decoy }));

      const windows = host(home);
      expect(await rememberedWindowsDir("APPDATA", windows.ask)).toBe(home);
      expect(windows.count).toBe(1);
    });
  });
});

describe("the record", () => {
  test("round-trips, and says who wrote it", async () => {
    const dirs = { APPDATA: "/mnt/c/Users/me/AppData/Roaming", LOCALAPPDATA: "/mnt/c/x" };
    const body = windowsEnvRecord(dirs);

    expect(body).toContain("Managed by red-dev");
    expect(parseWindowsEnvRecord(body)).toEqual(dirs);
  });

  test("ignores what it does not understand rather than throwing it away", async () => {
    // A record half-written by an interrupted run, or one a person
    // annotated. Nothing here is worth failing a converge over: an
    // unreadable line costs one cmd.exe.
    expect(parseWindowsEnvRecord("# a note\n\nAPPDATA=/mnt/c/a\nnonsense\n=empty\n")).toEqual({
      APPDATA: "/mnt/c/a",
    });
  });
});
