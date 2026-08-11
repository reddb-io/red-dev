import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { probeOpenStdin } from "./statusline-health.ts";

describe("statusline lifecycle probe", () => {
  test("this repository ships one portable producer with its deadline inside", () => {
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      statusLine: { command: string };
    };
    const command = settings.statusLine.command;

    expect(command).toBe("bun run src/main.ts statusline");
    expect(command.match(/\bstatusline\b/g)).toHaveLength(1);
  });

  test("distinguishes a consumer that handles input from one that waits for EOF", async () => {
    const handlesData = await probeOpenStdin(
      [process.execPath, "-e", "process.stdin.once('data',()=>process.exit(0));setInterval(()=>{},1000)"],
      250,
    );
    const waitsForEof = await probeOpenStdin(
      [process.execPath, "-e", "process.stdin.resume();process.stdin.once('end',()=>process.exit(0))"],
      75,
    );

    expect(handlesData).toMatchObject({ bounded: true, groupGone: true });
    expect(waitsForEof).toMatchObject({ bounded: false, groupGone: true });
  });

  test("a producer that exits but strands a descendant is unhealthy and gets cleaned up", async () => {
    const result = await probeOpenStdin([
      process.execPath,
      "-e",
      "require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref()",
    ], 250);

    expect(result).toMatchObject({ bounded: false, groupGone: true });
  });

  test("one hundred executions of the shipped recipe leave no process group behind", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-statusline-soak-`);
    mkdirSync(`${root}/.cache/red-skills/bundles`, { recursive: true });
    writeFileSync(
      `${root}/.cache/red-skills/bundles/dev-0.bundle.min.mjs`,
      "process.stdin.resume();await new Promise(resolve=>process.stdin.once('end',resolve));",
    );
    const command = (JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      statusLine: { command: string };
    }).statusLine.command;
    const results = [];
    try {
      for (let batch = 0; batch < 5; batch++) {
        results.push(
          ...(await Promise.all(
            Array.from({ length: 20 }, () =>
              probeOpenStdin([
                "env",
                `HOME=${root}`,
                `RED_DEV_STATUSLINE_BUNDLE=${root}/.cache/red-skills/bundles/dev-0.bundle.min.mjs`,
                "sh",
                "-c",
                command,
              ], 2_750)
            ),
          )),
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(results).toHaveLength(100);
    expect(results.every((result) => result.bounded && result.groupGone)).toBe(true);
  }, 15_000);

  test("the shipped command caps a bundle that ignores both input and EOF at two seconds", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-statusline-`);
    mkdirSync(`${root}/.cache/red-skills/bundles`, { recursive: true });
    writeFileSync(
      `${root}/.cache/red-skills/bundles/dev-0.bundle.min.mjs`,
      "setInterval(()=>{},1000);",
    );
    const command = (JSON.parse(readFileSync(".claude/settings.json", "utf8")) as {
      statusLine: { command: string };
    }).statusLine.command;
    const started = performance.now();
    try {
      const result = await probeOpenStdin([
        "env",
        `HOME=${root}`,
        `RED_DEV_STATUSLINE_BUNDLE=${root}/.cache/red-skills/bundles/dev-0.bundle.min.mjs`,
        "sh",
        "-c",
        command,
      ], 2_100);
      expect(result).toMatchObject({ bounded: true, groupGone: true });
      expect(performance.now() - started).toBeGreaterThan(750);
      expect(performance.now() - started).toBeLessThan(2_100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
