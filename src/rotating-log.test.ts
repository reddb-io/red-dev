import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDiagnostic, diagnosticRecord } from "./rotating-log.ts";

const roots: string[] = [];
function fixture() { const root = mkdtempSync(join(tmpdir(), "red-dev-log-test-")); roots.push(root); return root; }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("bounded diagnostics", () => {
  test("rotates before crossing the limit, reopens after rotation and retains four archives", () => {
    const root = fixture();
    const path = join(root, "app.log");
    for (let i = 0; i < 8; i++) appendDiagnostic(path, `${i}`.repeat(100), { maxBytes: 128 });
    expect(readdirSync(root).sort()).toEqual(["app.log", "app.log.1", "app.log.2", "app.log.3", "app.log.4"]);
    expect(readFileSync(path, "utf8")).toBe("7".repeat(100));
    expect(readFileSync(`${path}.4`, "utf8")).toBe("3".repeat(100));
    appendDiagnostic(path, "restart", { maxBytes: 128 });
    expect(statSync(path).size).toBe(107);
  });

  test("bounds UTF-8 and redacts before truncation", () => {
    const text = diagnosticRecord(`token="${"s".repeat(600)}" ${"🚀".repeat(200)}`, 128);
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(128);
    expect(text).toContain("[REDACTED]");
    expect(text).not.toContain("sss");
    expect(text).not.toContain("�");
    expect(text).toContain("truncated");
  });

  test("does not persist common credential forms or CLI secrets", () => {
    const path = join(fixture(), "app.log");
    appendDiagnostic(path, 'Authorization: Bearer abc123\n--password "do not persist"\nhttps://me:private@example.com api_key=hidden');
    const persisted = readFileSync(path, "utf8");
    for (const secret of ["abc123", "do not persist", "private", "hidden"]) expect(persisted).not.toContain(secret);
  });

  test("normalizes oversized legacy history and protects existing archive permissions", () => {
    const root = fixture();
    const path = join(root, "app.log");
    writeFileSync(path, "old row\n".repeat(100), { mode: 0o644 });
    writeFileSync(`${path}.1`, "older row\n".repeat(100), { mode: 0o644 });
    appendDiagnostic(path, "new\n", { maxBytes: 128 });
    for (const file of readdirSync(root)) {
      expect(statSync(join(root, file)).size).toBeLessThanOrEqual(128);
      if (process.platform !== "win32") expect(statSync(join(root, file)).mode & 0o777).toBe(0o600);
    }
    expect(diagnosticRecord('token="first-line\nsecond-line"')).toBe('token="[REDACTED]"');
  });

  test("uses private files and refuses symlinks without touching their targets", () => {
    const root = fixture();
    const path = join(root, "app.log");
    appendDiagnostic(path, "safe");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    const link = join(root, "link.log");
    symlinkSync(path, link);
    expect(() => appendDiagnostic(link, "overwrite")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("safe");
    expect(existsSync(`${link}.lock`)).toBe(false);
  });

  test("does not reclaim a live writer's lock", () => {
    const path = join(fixture(), "app.log");
    writeFileSync(`${path}.lock`, `${process.pid}\n`);
    expect(() => appendDiagnostic(path, "racing")).toThrow("busy");
    expect(existsSync(path)).toBe(false);
    expect(readFileSync(`${path}.lock`, "utf8")).toBe(`${process.pid}\n`);
  });

  test("concurrent independent processes keep archives within the budget", async () => {
    const root = fixture();
    const path = join(root, "app.log");
    const module = new URL("./rotating-log.ts", import.meta.url).pathname;
    const script = `import { appendDiagnostic } from ${JSON.stringify(module)}; for(let n=0;n<15;n++) appendDiagnostic(${JSON.stringify(path)}, 'x'.repeat(80)+'\\n', {maxBytes:256});`;
    const children = Array.from({ length: 3 }, () => Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" }));
    for (const child of children) expect(await child.exited).toBe(0);
    const files = readdirSync(root);
    expect(files.length).toBeLessThanOrEqual(5);
    for (const file of files) expect(statSync(join(root, file)).size).toBeLessThanOrEqual(256);
  });
});
