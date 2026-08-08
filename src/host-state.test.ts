/**
 * The daemon's host-state, read for the one number Redwall draws from it.
 *
 * Three of these tests are the same rule stated three ways: a Worker count
 * that cannot be trusted is dropped, and nothing else is. A daemon that is
 * not running, a payload this build cannot read, and a version skew all end
 * in `null` — never in a throw, because the caller composing a Redwall still
 * has an address to draw and must not lose it to an absent daemon.
 *
 * The fourth is the one that makes the other three worth anything: a host
 * with no Workers reports `{ workers: 0 }`, which is a different value from
 * `null`. Collapsing them would make "the queue drained" and "the daemon is
 * gone" the same picture on the wallpaper.
 *
 * The payload is a real capture from `redskilled host-state`, with the
 * machine's own identifiers and paths replaced. What it pins is the shape
 * the daemon actually emits — a shape with sixteen top-level keys, of which
 * this module reads three.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  HOST_STATE_PROTOCOL_VERSION,
  HOST_STATE_VERSION,
  hostStateFrom,
  parseHostState,
  readHostState,
} from "./host-state.ts";

// Read as text rather than imported as a module, so what the parser is given
// is the bytes the daemon printed — an import would hand it a document
// TypeScript had already decided the shape of.
const fixture = readFileSync("src/fixtures/redskilled-host-state.json", "utf8");
const captured = JSON.parse(fixture) as Record<string, unknown>;

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...captured, ...over };
}

describe("a payload the daemon really emitted", () => {
  test("yields the Worker count it declares", () => {
    const workers = captured["workers"] as unknown[];
    // Both numbers come from the capture rather than from a literal, so the
    // assertion cannot drift from the fixture it is reading.
    expect(workers.length).toBeGreaterThan(0);
    expect(hostStateFrom(captured)).toEqual({ workers: workers.length });
  });

  test("counts Workers, not the slots the host would allow", () => {
    // The ceiling is the machine's capacity and the demand block is what the
    // daemon wants; neither is what is running. A reader that took either
    // would draw a full machine on an idle one.
    const state = hostStateFrom(payload({ workers: [], projects: [] }));
    expect(state).toEqual({ workers: 0 });
  });

  test("is read the same way from its JSON text", () => {
    expect(parseHostState(fixture)).toEqual(hostStateFrom(captured));
  });
});

describe("a version this build does not understand", () => {
  test("drops the Worker count rather than reading it anyway", () => {
    expect(hostStateFrom(payload({ version: HOST_STATE_VERSION + 1 }))).toBeNull();
  });

  test("drops it on a protocol skew too", () => {
    expect(hostStateFrom(payload({ protocol_version: HOST_STATE_PROTOCOL_VERSION + 1 }))).toBeNull();
  });

  test("throws nothing on the way", () => {
    // Stated separately from the value, because the caller's other half — the
    // address — is lost to an exception just as surely as to a wrong number.
    expect(() => hostStateFrom(payload({ version: "1" }))).not.toThrow();
    expect(() => parseHostState("{ not json")).not.toThrow();
    expect(parseHostState("{ not json")).toBeNull();
  });

  test("drops it when the Worker set is missing or malformed", () => {
    expect(hostStateFrom(payload({ workers: 6 }))).toBeNull();
    expect(hostStateFrom({ version: 1, protocol_version: 1 })).toBeNull();
    expect(hostStateFrom(null)).toBeNull();
    expect(hostStateFrom([captured])).toBeNull();
  });
});

describe("a daemon that is not running", () => {
  test("yields no Worker count and no error", async () => {
    expect(await readHostState(async () => null)).toBeNull();
  });

  test("is not distinguishable from one that answered with nothing", async () => {
    expect(await readHostState(async () => "")).toBeNull();
  });

  test("survives a reader that fails outright", async () => {
    // Spawning a command that is not installed rejects rather than returning
    // nothing, and an absent red-skills checkout is the common case on a
    // machine that only ever wanted the wallpaper.
    expect(
      await readHostState(async () => {
        throw new Error("ENOENT");
      }),
    ).toBeNull();
  });

  test("is distinguishable from a host with no Workers", async () => {
    const idle = JSON.stringify(payload({ workers: [], projects: [] }));
    expect(await readHostState(async () => idle)).toEqual({ workers: 0 });
    expect(await readHostState(async () => null)).toBeNull();
  });
});
