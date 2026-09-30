import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeDoctorReport, writeDoctorReport } from "./doctor-report.ts";

test("export keeps valid JSON while removing home paths and credential forms", () => {
  const encoded = encodeDoctorReport({ lines: ["\x1b[31m/home/alice/tools\x1b[0m", "Authorization: Bearer private-token", "https://alice:password@proxy.example", "github_pat_12345678901234567890"] }, "/home/alice");
  expect(JSON.parse(encoded).lines[0]).toBe("<home>/tools");
  for (const secret of ["private-token", "password", "github_pat_123", "/home/alice", "\\u001b"]) expect(encoded).not.toContain(secret);
});

test("explicit export is private and never overwrites an existing report", () => {
  const root = mkdtempSync(join(tmpdir(), "red-dev-report-")); const path = join(root, "report.json");
  try {
    writeDoctorReport(path, '{"schema":"fixture"}');
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(() => writeDoctorReport(path, "replacement")).toThrow();
    expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe("fixture");
    if (process.platform !== "win32") {
      writeFileSync(join(root, "target"), "preserve me"); symlinkSync(join(root, "target"), join(root, "link"));
      expect(() => writeDoctorReport(join(root, "link"), "replacement")).toThrow();
      expect(readFileSync(join(root, "target"), "utf8")).toBe("preserve me");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
