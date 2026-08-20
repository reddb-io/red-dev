/**
 * The composer, checked the way a desktop cannot check it.
 *
 * Every claim Spec #52 makes about a Redwall is a claim about bytes, and
 * that is the whole design: purity is what makes "did the state change"
 * answerable by comparison, and it is what lets a build with no desktop
 * attached have an opinion at all.
 *
 * Two of these are the same assertion pointing opposite ways —
 * identical inputs must produce identical output, and a different Worker
 * count must produce different output. Either one alone passes for a
 * renderer that ignores its arguments.
 *
 * The legibility half lives in `theme-contrast.test.ts`, beside every
 * other pair this project measures, because that is the table a colour
 * change has to get past. What is here is the pixels: that the two
 * colours the theme declares are the two colours that actually landed.
 */

import { describe, expect, test } from "bun:test";
import { contrast } from "./brand.ts";
import { decodePng, encodePng, type Raster } from "./png.ts";
import { REDWALL_CHARSET } from "./redwall-charset.ts";
import { REDWALL_SUBSET } from "./redwall-font.ts";
import {
  AGENT_WINDOW_KINDS,
  redwallBox,
  redwallInk,
  redwallLines,
  renderRedwall,
  yearCells,
  yearProgress,
  yearProgressLabel,
  type RedwallState,
  type RedwallYear,
} from "./redwall-render.ts";
import { THEMES, THEME_SLUGS, type ThemeSlug } from "./themes.ts";
import { readFont } from "./ttf.ts";

const root = `${import.meta.dir}/..`;
const fontBytes = await Bun.file(REDWALL_SUBSET).bytes();
const font = readFont(fontBytes);

/**
 * Stand-in art: a two-way gradient, so that a pixel moved by one in
 * either direction is a pixel with a different value.
 */
function sheet(width = 1280, height = 720): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      data[at] = x & 0xff;
      data[at + 1] = y & 0xff;
      data[at + 2] = (x + y) & 0xff;
      data[at + 3] = 255;
    }
  }
  return { width, height, data };
}

const art = encodePng(sheet());
const running: RedwallState = { workers: 3, address: "192.168.1.42" };
const YEAR = yearProgress(new Date(2026, 7, 12, 12));

function render(
  state: RedwallState,
  slug: ThemeSlug = "dark",
  year: RedwallYear = YEAR,
): Uint8Array {
  return renderRedwall({ art, font: fontBytes, theme: THEMES[slug], state, year });
}

describe("the current year", () => {
  test("becomes stable civil-calendar progress", () => {
    expect(YEAR).toEqual({ year: 2026, elapsed: 224, days: 365, firstWeekday: 4 });
    expect(yearProgressLabel(YEAR)).toBe("2026 · 61%");
    expect(yearProgress(new Date(2024, 11, 31, 23))).toEqual({
      year: 2024,
      elapsed: 366,
      days: 366,
      firstWeekday: 1,
    });
  });

  test("maps every day to weekday rows and week columns", () => {
    const cells = yearCells(YEAR);
    expect(cells).toHaveLength(365);
    expect(cells[0]).toEqual({ day: 1, column: 0, row: 4, state: "past" });
    expect(cells[222]?.state).toBe("past");
    expect(cells[223]?.state).toBe("today");
    expect(cells[224]?.state).toBe("future");
    expect(Math.max(...cells.map((cell) => cell.column))).toBe(52);
    expect(new Set(cells.map((cell) => `${cell.column}:${cell.row}`)).size).toBe(365);
  });

  test("changes the image on the next day, not later on the same day", () => {
    const morning = yearProgress(new Date(2026, 7, 12, 8));
    const evening = yearProgress(new Date(2026, 7, 12, 22));
    const tomorrow = yearProgress(new Date(2026, 7, 13, 8));
    expect([...render(running, "dark", morning)]).toEqual([...render(running, "dark", evening)]);
    expect([...render(running, "dark", morning)]).not.toEqual([
      ...render(running, "dark", tomorrow),
    ]);
  });
});

describe("the same inputs", () => {
  test("produce byte-identical output", () => {
    // Not "an equivalent image". The regenerator decides whether the
    // desktop needs rewriting by comparing what it just composed with
    // what is already there, and a renderer that varied by a compression
    // timestamp would rewrite the wallpaper on every tick.
    expect([...render(running)]).toEqual([...render(running)]);
  });

  test("and unavailable is still a state when the route is unknown", () => {
    expect(redwallLines({ workers: null, address: null })).toEqual(["redskilled unavailable"]);
    expect([...render({ workers: null, address: null })]).not.toEqual([...art]);
  });
});

describe("a different state", () => {
  test("is a different image when the Worker count changes", () => {
    expect([...render(running)]).not.toEqual([...render({ ...running, workers: 4 })]);
  });

  test("including when the count goes to zero, which is not the same as unknown", () => {
    // `host-state.ts` exists to keep these two apart: a drained queue
    // reports zero, a stopped daemon reports nothing. A renderer that
    // drew them the same would undo that distinction at the last step.
    const drained = render({ ...running, workers: 0 });
    const unknown = render({ ...running, workers: null });
    expect([...drained]).not.toEqual([...unknown]);
  });

  test("and when the address changes", () => {
    expect([...render(running)]).not.toEqual([...render({ ...running, address: "10.0.0.1" })]);
  });

  test("and when the theme changes, because the ink and the plate do", () => {
    expect([...render(running, "dark")]).not.toEqual([...render(running, "light")]);
  });
});

describe("the brand art underneath", () => {
  test("is present unmodified outside the region the overlay occupies", () => {
    const before = sheet();
    const after = decodePng(render(running));
    const box = redwallBox(before, font, redwallLines(running), YEAR)!;

    let moved = 0;
    let insideBox = 0;
    for (let y = 0; y < before.height; y++) {
      for (let x = 0; x < before.width; x++) {
        const inside =
          x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
        if (inside) {
          insideBox++;
          continue;
        }
        const at = (y * before.width + x) * 4;
        for (let c = 0; c < 4; c++) {
          if (before.data[at + c] !== after.data[at + c]) moved++;
        }
      }
    }

    expect(moved).toBe(0);
    // And the region is a region: an overlay that occupied nothing would
    // pass the assertion above without drawing anything.
    expect(insideBox).toBeGreaterThan(0);
    expect(insideBox).toBeLessThan(before.width * before.height);
  });

  test("survives a real sheet, at the size a real desktop asks for", async () => {
    // The synthetic art above is 1280x720 and has no mark on it. The
    // vendored sheets are 3840x2160 and are the actual subject, and the
    // scale arithmetic is the part that only shows up at their size.
    const real = await Bun.file(`${root}/assets/wallpapers/dark.png`).bytes();
    const before = decodePng(real);
    const after = decodePng(
      renderRedwall({ art: real, font: fontBytes, theme: THEMES.dark, state: running, year: YEAR }),
    );
    const box = redwallBox(before, font, redwallLines(running), YEAR)!;

    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    // The overlay is a corner of the desktop, not a banner across it.
    expect(box.width).toBeLessThan(before.width / 3);
    expect(box.height).toBeLessThan(before.height / 6);

    let moved = 0;
    for (let y = 0; y < before.height; y++) {
      if (y >= box.y && y < box.y + box.height) continue;
      for (let x = 0; x < before.width * 4; x++) {
        if (before.data[y * before.width * 4 + x] !== after.data[y * before.width * 4 + x]) moved++;
      }
    }
    expect(moved).toBe(0);
  });

  test("keeps the machine state quiet and out of the way at the top right", async () => {
    const real = await Bun.file(`${root}/assets/wallpapers/flare.png`).bytes();
    const before = decodePng(real);
    const box = redwallBox(before, font, redwallLines(running), YEAR)!;

    // Desktop icons own the left edge. The top-right keeps the state visible
    // without competing with the taskbar and Windows activation watermark.
    expect(box.x).toBeGreaterThan(before.width * 0.75);
    expect(box.y).toBeGreaterThan(0);
    expect(box.y + box.height).toBeLessThan(before.height * 0.15);

    // It is a small instrument, not a second brand mark. These bounds are
    // deliberately relative so the same apparent weight survives on 1080p
    // and 4K sheets.
    expect(box.width).toBeLessThan(before.width / 8);
    // The year grid adds useful vertical density, but the whole instrument
    // still occupies less than one eighth of the desktop height.
    expect(box.height).toBeLessThan(before.height / 8);
  });

  test("clears the GNOME top bar after a 4K sheet is fitted to the desktop", async () => {
    const real = await Bun.file(`${root}/assets/wallpapers/flare.png`).bytes();
    const before = decodePng(real);
    const box = redwallBox(before, font, redwallLines(running), YEAR)!;

    // Captured failure: a 3840px sheet displayed on a 1600px-wide GNOME
    // desktop. Its 22px top bar covered the beginning of the instrument.
    // Keep a little breathing room below system chrome as well as clearing it.
    const displayScale = 1600 / before.width;
    const displayedTop = box.y * displayScale;
    expect(displayedTop).toBeGreaterThanOrEqual(22 + 8);
  });

  test("is a rounded instrument with the brand signal at its edge", () => {
    const before = sheet();
    const after = decodePng(render(running));
    const box = redwallBox(before, font, redwallLines(running), YEAR)!;
    const corner = (box.y * before.width + box.x) * 4;
    const middle = ((box.y + Math.floor(box.height / 2)) * before.width + box.x) * 4;

    // A rounded corner leaves the art below it untouched; halfway down, the
    // narrow first column is the theme signal rather than the old square plate.
    expect([...after.data.slice(corner, corner + 4)])
      .toEqual([...before.data.slice(corner, corner + 4)]);
    expect([...after.data.slice(middle, middle + 3)])
      .not.toEqual([...before.data.slice(middle, middle + 3)]);
    expect([...after.data.slice(middle, middle + 3)])
      .not.toEqual(hexChannels(redwallInk(THEMES.dark).plate));
  });
});

describe("what actually landed inside the region", () => {
  test.each([...THEME_SLUGS])("%s writes its declared ink on its declared plate", (slug) => {
    const ink = redwallInk(THEMES[slug]);
    const after = decodePng(render(running, slug));
    const box = redwallBox(after, font, redwallLines(running), YEAR)!;

    const tally = new Map<string, number>();
    for (let y = box.y; y < box.y + box.height; y++) {
      for (let x = box.x; x < box.x + box.width; x++) {
        const at = (y * after.width + x) * 4;
        const hex = `#${[0, 1, 2].map((c) => after.data[at + c]!.toString(16).padStart(2, "0")).join("")}`;
        tally.set(hex, (tally.get(hex) ?? 0) + 1);
      }
    }

    expect(tally.get(ink.plate) ?? 0).toBeGreaterThan(0);
    const [pr, pg, pb] = hexChannels(ink.plate);
    const [tr, tg, tb] = hexChannels(ink.text);
    let titleBlend = 0;
    for (const [hex, count] of tally) {
      const [r, g, b] = hexChannels(hex);
      const between = (value: number, a: number, z: number): boolean =>
        value >= Math.min(a, z) && value <= Math.max(a, z);
      if (hex !== ink.plate && between(r, pr, tr) && between(g, pg, tg) && between(b, pb, tb)) {
        titleBlend += count;
      }
    }
    expect(titleBlend).toBeGreaterThan(0);
    expect(contrast(ink.text, ink.plate)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(ink.secondary, ink.plate)).toBeGreaterThanOrEqual(4.5);
  });

  test("and the two text levels come from the theme's declared hierarchy", () => {
    for (const slug of THEME_SLUGS) {
      const theme = THEMES[slug];
      expect(redwallInk(theme).text, slug).toBe(theme.text.strong);
      expect(redwallInk(theme).secondary, slug).toBe(theme.text.normal);
    }
  });
});

function hexChannels(hex: string): [number, number, number] {
  return [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [number, number, number];
}

describe("the lines", () => {
  test("turn ordinary activity into a human status with operational context", () => {
    expect(redwallLines({
      ...running,
      capacity: 6,
      queued: 18,
      attention: null,
      github: {
        pat: { api: 95, graphql: 0 },
        app: { api: 88, graphql: 72 },
      },
    })).toEqual([
      "redskilled at work",
      "3/6 workers · 18 queued",
      "github pat api 95% · gql 0%",
      "github app api 88% · gql 72%",
      "192.168.1.42",
    ]);
  });

  test("drops invalid GitHub percentages without dropping machine state", () => {
    expect(redwallLines({
      ...running,
      github: { pat: { api: 101, graphql: -1 }, app: null },
    })).toEqual(["redskilled at work", "3 workers", "192.168.1.42"]);
  });

  test("draws only PAT when the optional GitHub App is not configured", () => {
    expect(redwallLines({
      ...running,
      github: { pat: { api: 98, graphql: 85 }, app: null },
    })).toEqual([
      "redskilled at work",
      "3 workers",
      "github pat api 98% · gql 85%",
      "192.168.1.42",
    ]);
  });

  test("draw the agent allowance beside the GitHub budgets, remaining-first", () => {
    // Percent remaining, like the two lines above it. The fixture is a
    // reading, not a snapshot: taking one is `agent-usage.ts`'s job and
    // reading one is this module's, and the split is what keeps a
    // repaint incapable of collecting.
    expect(redwallLines({
      ...running,
      github: { pat: { api: 95, graphql: 90 }, app: null },
      agent: {
        provider: "claude",
        updatedAtMs: 1_760_000_000_000,
        windows: [
          { kind: "five_hour", usedPercent: 42, remainingPercent: 58, resetsAtMs: null },
          { kind: "seven_day", usedPercent: 18, remainingPercent: 82, resetsAtMs: null },
          { kind: "seven_day_opus", usedPercent: 9, remainingPercent: 91, resetsAtMs: null },
        ],
      },
    })).toEqual([
      "redskilled at work",
      "3 workers",
      "github pat api 95% · gql 90%",
      "agent claude 5h 58% · 7d 82% · 7d opus 91%",
      "192.168.1.42",
    ]);
  });

  test("say so when the allowance is unknown, rather than blanking the card", () => {
    // An absent snapshot arrives here as null, and the rest of the card
    // has to survive it. Nothing about a machine's Workers or address
    // stopped being true because a provider could not be read.
    expect(redwallLines({ ...running, agent: null })).toEqual([
      "redskilled at work",
      "3 workers",
      "agent unknown",
      "192.168.1.42",
    ]);
    expect(redwallLines({ workers: null, address: null, agent: null })).toEqual([
      "redskilled unavailable",
      "agent unknown",
    ]);
    // A window under a name this face was never cut for is another way
    // of not knowing, and it lands in the same place. The alternative is
    // an underscore the subset has no glyph for taking every line with it.
    expect(redwallLines({
      ...running,
      agent: {
        provider: "claude",
        updatedAtMs: 1_760_000_000_000,
        windows: [{ kind: "monthly", usedPercent: 5, remainingPercent: 95, resetsAtMs: null }],
      },
    })).toEqual(["redskilled at work", "3 workers", "agent unknown", "192.168.1.42"]);
    // And a provider naming itself in characters the face lacks costs
    // its own line and no other.
    expect(redwallLines({
      ...running,
      agent: {
        provider: "zed",
        updatedAtMs: 1_760_000_000_000,
        windows: [{ kind: "five_hour", usedPercent: 42, remainingPercent: 58, resetsAtMs: null }],
      },
    })).toEqual(["redskilled at work", "3 workers", "agent unknown", "192.168.1.42"]);
  });

  test("draw no agent line at all when nobody asked for one", () => {
    // Absent is not unknown. Every caller written before this existed
    // renders exactly what it did.
    expect(redwallLines(running)).toEqual([
      "redskilled at work",
      "3 workers",
      "192.168.1.42",
    ]);
  });

  test("and every agent line the overlay can produce is one the face can set", () => {
    const drawable = (line: string): boolean =>
      [...line].every((ch) => REDWALL_CHARSET.includes(ch));
    const windows = [...AGENT_WINDOW_KINDS].map((kind) => ({
      kind,
      usedPercent: 7,
      remainingPercent: 93,
      resetsAtMs: null,
    }));
    for (const line of redwallLines({ ...running, agent: null })) expect(drawable(line), line).toBe(true);
    for (
      const line of redwallLines({
        ...running,
        agent: { provider: "claude", updatedAtMs: 1_760_000_000_000, windows },
      })
    ) expect(drawable(line), line).toBe(true);
  });

  test("distinguishes standing by, capacity, attention and unavailable", () => {
    expect(redwallLines({ workers: 0, capacity: 6, queued: 0, attention: null, address: "10.1.2.3" }))
      .toEqual(["redskilled standing by", "nothing queued", "10.1.2.3"]);
    expect(redwallLines({ workers: 6, capacity: 6, queued: 3, attention: null, address: null }))
      .toEqual(["redskilled at capacity", "6/6 workers · 3 queued"]);
    expect(redwallLines({
      workers: 2,
      capacity: 6,
      queued: 18,
      attention: { kind: "births-paused", count: null },
      address: "10.1.2.3",
    })).toEqual(["redskilled needs attention", "worker births paused · 18 queued", "10.1.2.3"]);
    expect(redwallLines({ workers: null, address: "10.1.2.3" }))
      .toEqual(["redskilled unavailable", "10.1.2.3"]);
    expect(redwallLines({ workers: null, address: null }))
      .toEqual(["redskilled unavailable"]);
  });

  test("keeps the half that is known when the other is not", () => {
    expect(redwallLines({ workers: 2, address: null })).toEqual([
      "redskilled at work",
      "2 workers",
    ]);
    expect(redwallLines({ workers: null, address: null })).toEqual(["redskilled unavailable"]);
  });

  test("drop an address the embedded face was never cut for", () => {
    // Nothing produces an IPv6 address today. When something does, the
    // failure has to be one missing line rather than a wallpaper that
    // stops regenerating — and the charset test is what will say so.
    expect(redwallLines({ workers: 1, address: "fe80::1" })).toEqual([
      "redskilled at work",
      "1 worker",
    ]);
  });

  test("drop a count that has no digits-only decimal form", () => {
    for (const workers of [-1, 1.5, Number.NaN, 1e21, Number.POSITIVE_INFINITY]) {
      expect(redwallLines({ workers, address: null }), String(workers)).toEqual([]);
    }
  });

  test("and there is no box to draw when there are no lines", () => {
    expect(redwallBox({ width: 100, height: 100 }, font, [], YEAR)).toBeNull();
  });
});

describe("the revision on the card", () => {
  test("is drawn beside the name, in every state the card has", () => {
    // Which is the daemon's version by construction: redskilled is
    // installed out of the package set, so naming the set names the
    // thing the rest of the card reports on. The wallpaper answers
    // "which revision is this machine" without opening a terminal.
    const at = (over: Record<string, unknown>) =>
      redwallLines({ address: null, version: "4.0.11", ...over } as never)[0];

    expect(at({ workers: 0, queued: 0 })).toBe("redskilled 4.0.11 standing by");
    expect(at({ workers: 2, capacity: 5, queued: 1 })).toBe("redskilled 4.0.11 at work");
    expect(at({ workers: 5, capacity: 5, queued: 3 })).toBe("redskilled 4.0.11 at capacity");
    expect(at({ workers: null })).toBe("redskilled 4.0.11 unavailable");
    expect(at({ workers: 1, attention: { kind: "births-paused" } })).toBe(
      "redskilled 4.0.11 needs attention",
    );
  });

  test("a machine with no set draws the name alone, which is true", () => {
    const lines = redwallLines({ workers: 0, queued: 0, address: null } as never);
    expect(lines[0]).toBe("redskilled standing by");
    expect(lines[0]).not.toContain("undefined");
    expect(lines[0]).not.toContain("null");
  });

  test("a revision the face cannot set is dropped, not drawn as boxes", () => {
    // The same rule the address and the agent windows already follow: a
    // line the embedded face cannot set drops every other line with it,
    // so nothing unsettable is allowed into one.
    const lines = redwallLines({
      workers: 0,
      queued: 0,
      address: null,
      version: "4.0.11-日本語",
    } as never);
    expect(lines[0]).toBe("redskilled standing by");
  });
});
