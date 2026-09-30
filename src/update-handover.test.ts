import { expect, test } from "bun:test";
import { convergeUpdatedBinary } from "./update-handover.ts";
const ok = (stdout: string) => ({ stdout, stderr: "", exitCode: 0, timedOut: false, groupGone: true });

test("converges through the newer executable, without restarting update stages", async () => {
  const calls: unknown[] = [];
  const code = await convergeUpdatedBinary("1.0.178", { yes: true, dryRun: false }, async () => { throw new Error("old converge must not run"); }, {
    locate: () => "/new/red-dev", probe: async () => ok("1.0.179\n"),
    run: async (path, argv) => { calls.push([path, argv]); return 2; },
  });
  expect(calls).toEqual([["/new/red-dev", ["install", "--yes"]]]);
  expect(code).toBe(2);
});

test("uses the existing process for dry runs and the same version", async () => {
  let count = 0;
  const fallback = async () => { count++; return 0; };
  await convergeUpdatedBinary("1.0.178", { yes: false, dryRun: true }, fallback, { locate: () => { throw new Error("dry run must not probe"); } });
  await convergeUpdatedBinary("1.0.178", { yes: false, dryRun: false }, fallback, { locate: () => "/same/red-dev", probe: async () => ok("1.0.178") });
  expect(count).toBe(2);
});

test("never falls back to old convergence if the installed executable is unverifiable", async () => {
  expect(convergeUpdatedBinary("1.0.178", { yes: false, dryRun: false }, async () => { throw new Error("old fallback"); }, {
    locate: () => "/new/red-dev", probe: async () => ({ ...ok(""), timedOut: true }),
  })).rejects.toThrow("cannot verify");
});
