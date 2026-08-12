/**
 * Runtime installs must report both child streams.
 *
 * Real installers commonly put progress and failures on stderr. If that stream
 * is hidden, the terminal stays on the `:: mise: ...` line throughout the
 * download and the useful error is absent when the child finally exits.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded } from "./bounded-command.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("mise runtime install output", () => {
  test("a stderr-heavy failure terminates and exposes the actual error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "red-dev-runtime-"));
    created.push(dir);
    const fakeMise = join(dir, "mise");
    writeFileSync(
      fakeMise,
      `#!/usr/bin/env bun
if (Bun.argv[2] === "use") {
  console.log("ARGS: " + Bun.argv.slice(2).join(" "));
  console.log("resolving bun");
  for (let i = 0; i < 8_000; i++) console.error("download diagnostic " + i);
  console.error("REAL INSTALL ERROR: artifact unavailable");
  process.exit(19);
}
process.exit(0);
`,
    );
    chmodSync(fakeMise, 0o755);

    const harness = join(dir, "harness.ts");
    const runtimes = join(import.meta.dir, "runtimes.ts");
    writeFileSync(
      harness,
      `import { useRuntimes } from ${JSON.stringify(runtimes)};
let detail = "";
await useRuntimes(["bun@latest"], {
  stepEnd: (_id, error) => { detail = error ?? ""; },
});
console.log("OBSERVED: " + detail);
`,
    );

    const result = await runBounded([process.execPath, harness], {
      timeoutMs: 2_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--yes");
    expect(result.stdout).not.toContain("--verbose");
    expect(result.stdout + result.stderr).toContain(
      "REAL INSTALL ERROR: artifact unavailable",
    );
    expect(result.stdout).toContain("OBSERVED: REAL INSTALL ERROR: artifact unavailable");
  });

  test("one runtime failure does not prevent the next selection from running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "red-dev-runtime-"));
    created.push(dir);
    const fakeMise = join(dir, "mise");
    writeFileSync(
      fakeMise,
      `#!/usr/bin/env bun
const request = Bun.argv.at(-1) ?? "";
if (request === "node@lts") {
  console.log("NODE INSTALL COMPLETED");
  process.exit(0);
}
if (request.startsWith("python@")) {
  console.error("PYTHON INSTALL FAILED");
  process.exit(12);
}
if (request === "bun@latest") {
  console.log("BUN INSTALL COMPLETED");
  process.exit(0);
}
process.exit(2);
`,
    );
    chmodSync(fakeMise, 0o755);

    const harness = join(dir, "harness.ts");
    const runtimes = join(import.meta.dir, "runtimes.ts");
    writeFileSync(
      harness,
      `import { useRuntimes } from ${JSON.stringify(runtimes)};
const outcomes: Array<[string, string | null]> = [];
await useRuntimes(["node@lts", "python@3.13", "bun@latest"], {
  stepEnd: (id, error) => outcomes.push([id, error]),
});
console.log("OUTCOMES: " + JSON.stringify(outcomes));
`,
    );

    const result = await runBounded([process.execPath, harness], {
      timeoutMs: 2_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
    });

    expect(result.timedOut).toBe(false);
    expect(result.stdout).toContain("NODE INSTALL COMPLETED");
    expect(result.stdout).toContain("PYTHON INSTALL FAILED");
    expect(result.stdout).toContain("BUN INSTALL COMPLETED");
    expect(result.stdout).toContain(
      'OUTCOMES: [["node@lts",null],["python@3.13","PYTHON INSTALL FAILED"],["bun@latest",null]]',
    );
  });
});
