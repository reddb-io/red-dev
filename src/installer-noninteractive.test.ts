/**
 * Every provisioning child is unattended, and captured installers remain
 * observable while retaining enough output to explain a non-zero exit.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { captureTo } from "./log.ts";
import { installerInstall, providerStdinMode, spawnLoggedCapture } from "./providers.ts";

const providers = readFileSync(`${import.meta.dir}/providers.ts`, "utf8");
const agents = readFileSync(`${import.meta.dir}/agents.ts`, "utf8");
const blesh = readFileSync(`${import.meta.dir}/blesh.ts`, "utf8");

describe("unattended provider commands", () => {
  test("a real terminal never grants an installer access to the keyboard", () => {
    expect(providerStdinMode(true)).toBe("ignore");
    expect(providerStdinMode(false)).toBe("ignore");
  });

  test("captured stdout and stderr are both live and retained", async () => {
    const seen: string[] = [];
    const release = captureTo((line) => seen.push(line));
    try {
      const result = await spawnLoggedCapture([
        process.execPath,
        "-e",
        'console.log("LIVE OUT"); console.error("LIVE ERROR"); process.exit(7)',
      ]);
      expect(result.code).toBe(7);
      expect(result.out).toContain("LIVE OUT");
      expect(result.err).toContain("LIVE ERROR");
      expect(seen).toContain("LIVE OUT");
      expect(seen).toContain("LIVE ERROR");
    } finally {
      release();
    }
  });

  test("carriage-return progress reaches the TUI before the child exits", async () => {
    const seen: string[] = [];
    const release = captureTo((line) => seen.push(line));
    try {
      const child = spawnLoggedCapture([
        process.execPath,
        "-e",
        'process.stderr.write("download 25%\\r"); setTimeout(() => process.stderr.write("download 100%\\n"), 250)',
      ]);

      await Bun.sleep(100);
      expect(seen).toContain("download 25%");
      await child;
    } finally {
      release();
    }
  });

  test("a silent child reports that it is alive before it finishes", async () => {
    const seen: string[] = [];
    const release = captureTo((line) => seen.push(line));
    try {
      const child = spawnLoggedCapture(
        [
          process.execPath,
          "-e",
          'setTimeout(() => console.log("FINISHED"), 180)',
        ],
        { heartbeatMs: 40 },
      );

      await Bun.sleep(110);
      expect(seen.some((line) => line.includes("still running"))).toBe(true);
      expect(seen.some((line) => line.includes("no output for"))).toBe(true);
      expect(
        seen.filter((line) => line.includes("still running")).length,
      ).toBeGreaterThanOrEqual(2);
      await child;
    } finally {
      release();
    }
  });

  test("a vendor script fetch stays observable before response headers arrive", async () => {
    const seen: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(180);
        return new Response("#!/bin/sh\nexit 0\n");
      },
    });
    const release = captureTo((line) => seen.push(line));
    try {
      const install = installerInstall(
        `http://127.0.0.1:${server.port}/install.sh`,
        "delayed fixture",
        [],
        undefined,
        { heartbeatMs: 40, timeoutMs: 1_000 },
      );

      await Bun.sleep(110);
      const beforeHeaders = [...seen];
      await install;
      expect(beforeHeaders.some((line) => line.includes("fetch still running"))).toBe(true);
      expect(beforeHeaders.some((line) => line.includes("no response data for"))).toBe(true);
    } finally {
      release();
      server.stop(true);
    }
  });

  test("a vendor script fetch has a total deadline instead of waiting forever", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        await Bun.sleep(5_000);
        return new Response("#!/bin/sh\nexit 0\n");
      },
    });
    try {
      await expect(
        installerInstall(
          `http://127.0.0.1:${server.port}/install.sh`,
          "stalled fixture",
          [],
          undefined,
          { heartbeatMs: 20, timeoutMs: 80 },
        ),
      ).rejects.toThrow(/installer download did not finish within/);
    } finally {
      server.stop(true);
    }
  });

  test("every winget path uses the observable capture helper", () => {
    expect(providers).toContain("await spawnLoggedCapture(");
    expect(agents).toContain("await spawnLoggedCapture(argv)");
  });

  test("winget upgrades explicitly disable interaction", () => {
    const start = providers.indexOf("export async function systemUpdate");
    const end = providers.indexOf("// -------------------------------------------------------- dispatch", start);
    expect(providers.slice(start, end)).toContain('"--disable-interactivity"');
  });

  test("ble.sh routes command output through the shared logger", () => {
    expect(blesh).toContain('import("./providers.ts")');
    expect(blesh).toContain("spawnLogged(cmd)");
    expect(blesh).not.toContain('stdout: "ignore", stderr: "ignore"');
  });
});
