/**
 * Every provisioning child is unattended, and captured installers remain
 * observable while retaining enough output to explain a non-zero exit.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { captureTo } from "./log.ts";
import { providerStdinMode, spawnLoggedCapture } from "./providers.ts";

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
