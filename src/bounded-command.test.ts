import { describe, expect, test } from "bun:test";
import { runBounded } from "./bounded-command.ts";

describe("bounded host probes", () => {
  test("a timed-out command cannot leave its process group behind", async () => {
    const started = performance.now();
    const result = await runBounded(["bash", "-c", "sleep 30 & wait"], { timeoutMs: 75 });

    expect(result).toMatchObject({ timedOut: true, groupGone: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("the deadline includes pipes held open after the parent exits", async () => {
    const started = performance.now();
    const result = await runBounded([
      process.execPath,
      "-e",
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:['ignore','inherit','inherit']}).unref()",
    ], { timeoutMs: 75 });

    expect(result).toMatchObject({ timedOut: true, groupGone: true });
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("an escaped descendant holding stdout cannot defeat the absolute deadline", async () => {
    const started = performance.now();
    const result = await runBounded([
      process.execPath,
      "-e",
      "require('child_process').spawn(process.execPath,['-e','setTimeout(()=>{},1000)'],{detached:true,stdio:['ignore','inherit','inherit']}).unref()",
    ], { timeoutMs: 75, killGraceMs: 75 });

    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
