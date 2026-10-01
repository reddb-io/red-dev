import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireUpdateLock, jobDue, nextJobState, readUpdateClock, runUpdateJob, withUpdateLock } from "./update-coordinator.ts";
import { runMaintenance } from "./maintenance.ts";
import type { Platform } from "./platform.ts";
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })));
function path() { const root = mkdtempSync(join(tmpdir(), "red-coordinator-")); roots.push(root); return join(root, "clock.json"); }
test("simultaneous entry points share one writer, including a slow live writer", async () => {
  const p = path(); const release = acquireUpdateLock(p)!;
  expect(await withUpdateLock(async () => { throw Error("must not run"); }, p)).toEqual({ busy: true });
  expect(acquireUpdateLock(p)).toBeNull();
  release();
  expect(await withUpdateLock(async () => 7, p)).toEqual({ busy: false, value: 7 });
});
test("a crashed owner is recovered, while unknown owners are preserved", async () => {
  const p = path();
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  mkdirSync(`${p}.lock`); writeFileSync(join(`${p}.lock`, "owner.json"), JSON.stringify({ pid: child.pid, token: "old" }));
  const release = acquireUpdateLock(p); expect(release).not.toBeNull(); release!();
  mkdirSync(`${p}.lock`); writeFileSync(join(`${p}.lock`, "owner.json"), "unknown");
  expect(acquireUpdateLock(p)).toBeNull();
  expect(readFileSync(join(`${p}.lock`, "owner.json"), "utf8")).toBe("unknown");
});
test("failure is persisted and suppresses repeated automatic requests without erasing the last success", async () => {
  const p = path(); let calls = 0; const start = 100_000;
  await runUpdateJob("suite", 60_000, async () => true, { path: p, now: start, random: 0.5 });
  expect(await runUpdateJob("suite", 60_000, async () => { calls++; return false; }, { path: p, now: start + 60_000, random: 0.5 })).toBe("failed");
  expect(await runUpdateJob("suite", 60_000, async () => { calls++; return false; }, { path: p, now: start + 60_001 })).toBe("not-due");
  expect(calls).toBe(1);
  expect(readUpdateClock(p).jobs.suite?.succeededAt).toBe(start);
  expect(await runUpdateJob("suite", 60_000, async () => true, { path: p, now: start + 60_001, force: true })).toBe("ok");
  expect(readUpdateClock(p).jobs.suite?.failures).toBe(0);
});
test("retry delay grows, is bounded, spreads machines and recovers from clock changes", () => {
  const first = nextJobState(undefined, false, 100, 1000, 0.5);
  const second = nextJobState(first, false, first.nextAttemptAt, 1000, 0.5);
  expect(second.nextAttemptAt - second.attemptedAt).toBe(120_000);
  expect(nextJobState({ ...second, failures: 500 }, false, 100, 1000, 0.5).nextAttemptAt).toBe(100 + 6 * 60 * 60_000);
  expect(nextJobState(undefined, false, 100, 1000, 0).nextAttemptAt).not.toBe(nextJobState(undefined, false, 100, 1000, 1).nextAttemptAt);
  expect(jobDue(first, 50)).toBe(true);
});
test("one maintenance clock respects independent jobs, opt-outs and the remote destination", async () => {
  const p = path(); const calls: string[] = [];
  const platform = { os: "linux" } as Platform;
  const opts = { path: p, now: 100_000, env: { RED_SKILLS_WATCH: "0" },
    update: async () => { calls.push("suite"); return 0; },
    skills: async () => { throw Error("skills disabled"); },
    metadata: async () => { calls.push("metadata"); return null; },
    remote: async () => { calls.push("remote"); return 0; } };
  expect(await runMaintenance(platform, opts)).toBe(0);
  expect(await runMaintenance(platform, opts)).toBe(0);
  expect(calls.filter(c => c === "suite")).toHaveLength(1);
  expect(calls.filter(c => c === "remote")).toHaveLength(2);
});
