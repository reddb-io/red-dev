import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactDiagnostic } from "./rotating-log.ts";

/** Redact individual strings before serialization, preserving valid JSON. */
export function encodeDoctorReport(report: unknown, home = process.env.HOME ?? process.env.USERPROFILE): string {
  return JSON.stringify(report, (_key, value) => {
    if (typeof value !== "string") return value;
    const clean = redactDiagnostic(value).replace(/\x1b\[[0-9;]*m/g, "");
    return home ? clean.split(home).join("<home>") : clean;
  }, 2);
}

/** Explicit exports are private and refuse to overwrite files or symlinks. */
export function writeDoctorReport(path: string, encoded: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const fd = openSync(path, "wx", 0o600);
  try { writeFileSync(fd, `${encoded}\n`); }
  catch (error) { unlinkSync(path); throw error; }
  finally { closeSync(fd); }
}
