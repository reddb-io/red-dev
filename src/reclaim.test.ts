import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyReclaim,
  collectArtifactUsage,
  collectReclaimPlan,
  redDevStateRoot,
  selectCrashDumpRetention,
  windowsDiskUsage,
  windowsWslWorkerState,
  collectWslSwap,
} from "./reclaim.ts";
import type { RetainedFile } from "./retention.ts";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;
const now = Date.parse("2026-08-11T15:00:00.000Z");
const dump = (pid: number, ageDays: number): RetainedFile => ({
  path: `/dumps/claude.exe.${pid}.dmp`,
  name: `claude.exe.${pid}.dmp`,
  size: 600 * MIB,
  mtimeMs: now - ageDays * DAY,
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Windows CrashDump retention", () => {
  test("uses the same state root as transcripts in PowerShell and Git Bash", () => {
    expect(redDevStateRoot({ LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" }, "win32"))
      .toBe("C:/Users/dev/AppData/Local/red-dev/logs");
    expect(redDevStateRoot({
      HOME: "C:/Users/dev",
      LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local",
    }, "win32")).toBe("C:/Users/dev/.local/state/red-dev");
  });

  test("native Windows treats any running WSL distro as unknown without entering it", async () => {
    const commands: string[][] = [];
    const state = await windowsWslWorkerState("Ubuntu-24.04", async (argv) => {
      commands.push(argv);
      if (argv.includes("--list")) {
        return {
          stdout: "Ubuntu-24.04\0\r\0\n\0",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          groupGone: true,
        };
      }
      throw new Error("must not enter a distro during inventory");
    });

    expect(commands[0]?.slice(-3)).toEqual(["--list", "--running", "--quiet"]);
    expect(commands).toHaveLength(1);
    expect(state).toEqual({ known: false, workers: 0 });
  });

  test("a stopped WSL distro means zero Workers without starting it", async () => {
    const commands: string[][] = [];
    const state = await windowsWslWorkerState("Ubuntu-24.04", async (argv) => {
      commands.push(argv);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        timedOut: false,
        groupGone: true,
      };
    });

    expect(state).toEqual({ known: true, workers: 0 });
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("--running");
  });

  test("doctor reads C: capacity through bounded PowerShell JSON", async () => {
    const usage = await windowsDiskUsage(async () => ({
      stdout: '{"free":11918534246,"total":107374182400}',
      stderr: "",
      exitCode: 0,
      timedOut: false,
      groupGone: true,
    }));

    expect(usage).toEqual({ freeBytes: 11_918_534_246, totalBytes: 107_374_182_400 });
  });

  test("protects the newest three per executable and removes older dumps until under 2 GiB", () => {
    const selected = selectCrashDumpRetention(
      [dump(1, 10), dump(2, 9), dump(3, 8), dump(4, 7), dump(5, 6)],
      now,
    );

    expect(selected.map((item) => item.file.name)).toEqual([
      "claude.exe.1.dmp",
      "claude.exe.2.dmp",
    ]);
  });

  test("does not invent a dump TTL when usage is below the 2 GiB budget", () => {
    expect(selectCrashDumpRetention([dump(1, 120)], now)).toEqual([]);
  });
});

describe("Reclaim plan", () => {
  test("an oversized red-dev crash log is only selected by explicit Reclaim planning", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-crash-budget-`);
    roots.push(root);
    const state = `${root}/state`;
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/crash.log`, Buffer.alloc(11 * MIB));

    const plan = collectReclaimPlan({
      stateRoot: state,
      nowMs: now,
      includeCrashDumps: false,
    });
    expect(plan.items.map((item) => item.kind)).toEqual(["red-dev-crash"]);
  });

  test("doctor can report each derived artifact family without selecting it", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-usage-`);
    roots.push(root);
    const state = `${root}/state`;
    const dumps = `${root}/dumps`;
    mkdirSync(`${state}/zellij`, { recursive: true });
    mkdirSync(dumps, { recursive: true });
    writeFileSync(`${state}/2026-08-11T00-00-00-000-run.log`, "abc");
    writeFileSync(`${state}/zellij/crash-1.log`, "panic");
    writeFileSync(`${state}/crash.log`, "xx");
    writeFileSync(`${dumps}/claude.exe.1.dmp`, "1234567");

    expect(collectArtifactUsage(state, dumps)).toEqual({
      transcripts: { count: 1, bytes: 3 },
      zellijCrashes: { count: 1, bytes: 5 },
      redDevCrashes: { count: 1, bytes: 2 },
      windowsDumps: { count: 1, bytes: 7 },
    });
  });

  test("selects only derived files outside their retention budgets", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-reclaim-`);
    roots.push(root);
    const state = `${root}/state`;
    const zellij = `${state}/zellij`;
    mkdirSync(zellij, { recursive: true });
    for (let index = 0; index < 21; index++) {
      const path = `${state}/2026-08-${String(index + 1).padStart(2, "0")}T00-00-00-000-run.log`;
      writeFileSync(path, "log");
      utimesSync(path, (now - (21 - index) * HOUR) / 1_000, (now - (21 - index) * HOUR) / 1_000);
    }
    for (let index = 0; index < 11; index++) {
      const path = `${zellij}/crash-${100 + index}.log`;
      writeFileSync(path, "panic");
      utimesSync(path, (now - (11 - index) * HOUR) / 1_000, (now - (11 - index) * HOUR) / 1_000);
    }
    const previous = `${state}/crash.previous.log`;
    writeFileSync(previous, "old crash");
    utimesSync(previous, (now - 31 * DAY) / 1_000, (now - 31 * DAY) / 1_000);

    const plan = collectReclaimPlan({
      stateRoot: state,
      nowMs: now,
      includeCrashDumps: false,
      livePids: new Set([100]),
    });

    expect(plan.items.map((item) => item.kind).sort()).toEqual([
      "red-dev-crash",
      "transcript",
      "zellij-crash",
    ]);
  });

  test("apply skips a file that changed after the preview", () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-reclaim-`);
    roots.push(root);
    const state = `${root}/state`;
    mkdirSync(state, { recursive: true });
    const path = `${state}/crash.previous.log`;
    writeFileSync(path, "old");
    utimesSync(path, (now - 31 * DAY) / 1_000, (now - 31 * DAY) / 1_000);
    const plan = collectReclaimPlan({ stateRoot: state, nowMs: now, includeCrashDumps: false });
    writeFileSync(path, "new evidence that must survive");

    const result = applyReclaim(plan);

    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([{ path, reason: "file changed after preview" }]);
  });
});

describe("the WSL swap files a finished session leaves", () => {
  function tempWith(entries: { dir: string; file?: string; ageHours: number; size: number }[]): string {
    const root = mkdtempSync(join(tmpdir(), "red-swap-"));
    for (const entry of entries) {
      const dir = join(root, entry.dir);
      mkdirSync(dir, { recursive: true });
      const path = join(dir, entry.file ?? "swap.vhdx");
      writeFileSync(path, "x".repeat(entry.size));
      const when = new Date(Date.now() - entry.ageHours * 60 * 60 * 1000);
      utimesSync(path, when, when);
    }
    return root;
  }

  test("an old one is collected, and 19 GB is what this was missing", () => {
    // Measured on one machine: four of them, 19.4 GB, against 26 MB
    // free — while `reclaim` reported 1.5 MiB, because it knew only its
    // own transcripts.
    const root = tempWith([{ dir: "A1", ageHours: 48, size: 64 }]);
    const found = collectWslSwap(root, Date.now());
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe("swap.vhdx");
  });

  test("the live one is never taken, which is the whole risk here", () => {
    // WSL keeps the running VM's swap in the same place and writes to
    // it continuously. Taking that is taking the machine out from under
    // the person who asked.
    const root = tempWith([{ dir: "LIVE", ageHours: 0, size: 64 }]);
    expect(collectWslSwap(root, Date.now())).toEqual([]);
  });

  test("a directory holding anything else is left alone entirely", () => {
    // Then it is not the thing this recognises, and guessing about
    // somebody else's directory is how a cleanup becomes a loss.
    const root = tempWith([{ dir: "MIXED", ageHours: 48, size: 64 }]);
    writeFileSync(join(root, "MIXED", "notes.txt"), "mine");
    expect(collectWslSwap(root, Date.now())).toEqual([]);
  });

  test("only when asked for by name, like the crash dumps", () => {
    const root = tempWith([{ dir: "A1", ageHours: 48, size: 64 }]);
    const state = mkdtempSync(join(tmpdir(), "red-state-"));

    const casual = collectReclaimPlan({ stateRoot: state, includeCrashDumps: false, tempDir: root });
    expect(casual.items.some((item) => item.kind === "wsl-swap")).toBe(false);

    const asked = collectReclaimPlan({ stateRoot: state, includeCrashDumps: true, tempDir: root });
    expect(asked.items.some((item) => item.kind === "wsl-swap")).toBe(true);
  });
});
