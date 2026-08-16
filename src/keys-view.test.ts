/**
 * The viewer, driven through the real renderer.
 *
 * keys.test.ts proves the decisions: which rows are visible, where the
 * cursor is, what Enter chooses. None of that is worth anything if the
 * component never hands its keystrokes to the decider — a viewer wired
 * to nothing draws a correct first frame, ignores the keyboard, and
 * passes every test about its model. So this one writes real bytes into
 * a real render and reads the frames back out.
 *
 * The streams are PassThroughs dressed as a TTY, the same harness
 * tui-scroll.test.ts uses to cross the renderer boundary.
 */

import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { runKeysViewer } from "./keys-view.ts";
import { keyEntries, type FireOutcome, type KeyEntry } from "./keys.ts";
import type { Platform } from "./platform.ts";

const windows: Platform = {
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  arch: "x64",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
};

const strip = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const ESC = "\x1b";
const ENTER = "\r";

interface Driven {
  /** Everything the viewer drew, with the colour sequences taken out. */
  frames: string;
  fired: KeyEntry[];
}

/**
 * Open the viewer, type, and wait for it to close.
 *
 * Escape at the end of every script: the render owns the process's
 * attention until it exits, so a test that never sends one hangs rather
 * than fails.
 */
async function drive(keys: string[]): Promise<Driven> {
  const stdin = new PassThrough() as PassThrough & NodeJS.ReadStream;
  const stdout = new PassThrough() as PassThrough & NodeJS.WriteStream;
  Object.assign(stdin, { isTTY: true, isRaw: false, setRawMode: () => stdin });
  Object.assign(stdout, { isTTY: true, columns: 96, rows: 30 });

  let frames = "";
  stdout.on("data", (chunk: Buffer | string) => {
    frames += chunk.toString();
  });

  const fired: KeyEntry[] = [];
  const fire = async (entry: KeyEntry): Promise<FireOutcome> => {
    fired.push(entry);
    return { fired: true, detail: `${entry.label} — started` };
  };

  const done = runKeysViewer(windows, keyEntries(windows), fire, { stdin, stdout });
  for (const key of keys) {
    stdin.write(key);
    // A pause per keystroke, and it has to be this generous because of
    // Escape. A lone `\x1b` is the first byte of every arrow key, so the
    // parser holds it until either another byte arrives or enough time
    // passes — two escapes written close together arrive as one sequence
    // that means neither of them. Real fingers are slower than that;
    // this is the harness matching them, not a race being papered over.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await done;
  return { frames: strip(frames), fired };
}

describe("the drawn viewer", () => {
  test("lists every action with its chord before anything is typed", async () => {
    const { frames } = await drive([ESC]);
    expect(frames).toContain("Ctrl+Alt+T");
    expect(frames).toContain("Terminal");
    expect(frames).toContain("Elevated shell");
    expect(frames).toContain("red-dev keys");
  });

  test("typing reaches the filter — a query with no matches says so", async () => {
    // The wiring test. If useInput never reached viewerStep, the first
    // frame would still be right, both rows would still be listed, and
    // this line would never be drawn.
    //
    // Asserted on a line the viewer draws whole. The renderer patches
    // changed cells rather than repainting, so a row that was narrowed
    // one keystroke at a time never appears in the output as one string
    // — which is why the rest of these read behaviour instead.
    const { frames } = await drive([..."zzz", ESC, ESC]);
    expect(frames).toContain("nothing matches");
  });

  test("enter runs the action the search left highlighted", async () => {
    // `elevated` is the second row. Firing it means the cursor was
    // indexing the filtered list, which is the one thing that has to be
    // true for a search-then-enter to be a launcher rather than a
    // coin toss.
    const { fired } = await drive([..."elev", ENTER, ESC, ESC]);
    expect(fired.map((e) => e.id)).toEqual(["terminal.elevated"]);
  });

  test("and with nothing typed it runs the first row instead", async () => {
    // The other half of the previous test: without it, a viewer that
    // ignored the query and always fired row one would pass.
    const { fired } = await drive([ENTER, ESC]);
    expect(fired.map((e) => e.id)).toEqual(["terminal.new"]);
  });

  test("and says what it started, rather than going quiet", async () => {
    const { frames } = await drive([..."elev", ENTER, ESC, ESC]);
    expect(frames).toContain("Elevated shell — started");
  });

  test("escape clears the search before it closes, so a typo is not an exit", async () => {
    // If the first escape had quit, nothing would be listening for the
    // enter that follows and nothing would fire. That it fires the first
    // row is also the proof that the cleared query brought the whole
    // list back.
    const { fired } = await drive([..."elev", ESC, ENTER, ESC]);
    expect(fired.map((e) => e.id)).toEqual(["terminal.new"]);
  });
});
