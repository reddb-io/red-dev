import { describe, expect, test } from "bun:test";
import { inspectGnomeSession, type GnomeSessionOptions } from "./gnome-session.ts";

const socketPresent: GnomeSessionOptions = { env: {}, userBusSocket: true };
const owner = (present: boolean) => JSON.stringify({ type: "b", data: [present] });

describe("GNOME session presence", () => {
  test("the user bus reports whether Shell actually owns its name", async () => {
    for (const present of [true, false]) {
      let argv: readonly string[] = [];
      const state = await inspectGnomeSession({
        ...socketPresent,
        run: async args => { argv = args; return { code: 0, out: owner(present), err: "" }; },
      });
      expect(state).toBe(present ? "available" : "absent");
      expect(argv).toEqual([
        "busctl", "--user", "--json=short", "--timeout=3", "call",
        "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
        "NameHasOwner", "s", "org.gnome.Shell",
      ]);
    }
  });

  test("no bus socket and no explicit bus address is absence without a subprocess", async () => {
    let calls = 0;
    expect(await inspectGnomeSession({
      env: {}, userBusSocket: false,
      run: async () => { calls++; throw new Error("must not run"); },
    })).toBe("absent");
    expect(calls).toBe(0);
  });

  test("an explicit address is probed even when the default socket is absent", async () => {
    let calls = 0;
    expect(await inspectGnomeSession({
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:abstract=fixture" }, userBusSocket: false,
      run: async () => { calls++; return { code: 0, out: owner(true), err: "" }; },
    })).toBe("available");
    expect(calls).toBe(1);
  });

  test("permission errors, timeouts, unavailable executables and spawn errors are unknown", async () => {
    for (const failure of [
      { code: 1, out: "", err: "Permission denied" },
      { code: 124, out: "", err: "Timed out" },
      { code: 127, out: "", err: "busctl not found" },
    ]) {
      expect(await inspectGnomeSession({ ...socketPresent, run: async () => failure })).toBe("unknown");
    }
    expect(await inspectGnomeSession({ ...socketPresent, run: async () => { throw new Error("spawn failed"); } })).toBe("unknown");
  });

  test("an unreadable socket path is not mistaken for an absent session", async () => {
    expect(await inspectGnomeSession({
      env: {}, userBusSocket: null,
      run: async () => ({ code: 1, out: "", err: "Permission denied" }),
    })).toBe("unknown");
  });

  test("malformed, missing or mistyped replies are unknown, never absent", async () => {
    for (const out of [
      "false", "not JSON", "null", "[]", "{}",
      JSON.stringify({ type: "s", data: [false] }),
      JSON.stringify({ type: "b", data: ["false"] }),
      JSON.stringify({ type: "b", data: [] }),
      JSON.stringify({ type: "b", data: [false, true] }),
    ]) {
      expect(await inspectGnomeSession({ ...socketPresent, run: async () => ({ code: 0, out, err: "" }) })).toBe("unknown");
    }
  });
});
