/**
 * The apt batch has to be bracketed like a step.
 *
 * It is the one piece of work that runs between scopeStart and the first
 * stepStart, and the fullscreen view only redirects child output while a
 * bracket is open. Unbracketed, the loudest command of the whole run —
 * a hundred packages, minutes of progress bars — wrote straight to the
 * terminal and painted over the frame.
 *
 * The property that matters most is the second test: a batchStart whose
 * batchEnd never fires leaves the redirect open forever, and every line
 * after it disappears into a sink nobody is reading.
 */

import { describe, expect, test } from "bun:test";
import { runAptBatch, type ConvergeObserver } from "./converge.ts";

function recorder(): { events: string[]; observer: ConvergeObserver } {
  const events: string[] = [];
  return {
    events,
    observer: {
      batchStart: (pkgs) => events.push(`start:${pkgs.join(",")}`),
      batchEnd: (error) => events.push(`end:${error ?? "ok"}`),
    },
  };
}

describe("runAptBatch", () => {
  test("brackets a successful transaction", async () => {
    const { events, observer } = recorder();
    const seen: string[][] = [];
    const error = await runAptBatch(["git", "curl"], observer, async (pkgs) => {
      seen.push(pkgs);
      events.push("install");
    });
    expect(error).toBeNull();
    expect(events).toEqual(["start:git,curl", "install", "end:ok"]);
    expect(seen).toEqual([["git", "curl"]]);
  });

  test("closes the bracket when the transaction throws", async () => {
    const { events, observer } = recorder();
    const error = await runAptBatch(["git"], observer, async () => {
      throw new Error("apt-get install failed (100)");
    });
    expect(error).toBe("apt-get install failed (100)");
    expect(events).toEqual(["start:git", "end:apt-get install failed (100)"]);
  });

  test("reports the failure rather than throwing it", async () => {
    // The caller has to report the failure once per tool in the batch,
    // which it cannot do from inside a rejected promise.
    const { observer } = recorder();
    const promise = runAptBatch(["git"], observer, async () => {
      throw new Error("boom");
    });
    await expect(promise).resolves.toBe("boom");
  });

  test("survives an observer that implements neither hook", async () => {
    let ran = false;
    const error = await runAptBatch(["git"], {}, async () => {
      ran = true;
    });
    expect(ran).toBe(true);
    expect(error).toBeNull();
  });
});
