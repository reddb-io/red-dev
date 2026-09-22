/** Bounded, private diagnostic files. Never use this for recovery/event state. */
import {
  appendFileSync, closeSync, constants, fchmodSync, fstatSync, ftruncateSync, lstatSync,
  mkdirSync, openSync, readFileSync, readSync, renameSync, unlinkSync, writeFileSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";

export const LOG_MAX_BYTES = 10 * 1024 * 1024;
export const LOG_FILE_COUNT = 5;
export const LOG_RECORD_BYTES = 64 * 1024;

export interface LogLimits { maxBytes?: number; files?: number }

/** Known credential forms, applied before any record is truncated. */
export function redactDiagnostic(value: string): string {
  return value
    .replace(/(--[\w-]*(?:api[_-]?key|token|password|secret)\s+)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/\b(Bearer|Basic)\s+[^\s,'"}]+/gi, "$1 [REDACTED]")
    .replace(/(["']?\b[\w-]*(?:api[_-]?key|token|password|secret|authorization|cookie)["']?\s*[:=]\s*)(["'])([\s\S]*?)\2/gi, "$1\"[REDACTED]\"")
    // Header values contain spaces/semicolons: masking only the first cookie
    // would leave the remaining session credentials on the same line intact.
    .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*)[^\r\n]*/gi, "$1[REDACTED]")
    .replace(/(\b[\w-]*(?:api[_-]?key|token|password|secret|authorization|cookie)\s*[:=]\s*)(?!\[REDACTED\])[^\s,;&}"']+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:sk-[\w-]{10,}|gh[opusr]_[\w]{10,}|github_pat_[\w]{10,})\b/g, "[REDACTED]");
}

function prefix(value: string, cap: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= cap) return value;
  let end = cap;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8");
}

export function diagnosticRecord(value: string, maxBytes = LOG_MAX_BYTES): string {
  const clean = redactDiagnostic(value);
  const cap = Math.min(maxBytes, LOG_RECORD_BYTES);
  const marker = "\n[diagnostic record truncated]\n";
  return Buffer.byteLength(clean) <= cap ? clean : prefix(clean, cap - Buffer.byteLength(marker)) + marker;
}

function regular(path: string): ReturnType<typeof lstatSync> | null {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`refusing non-regular diagnostic file: ${path}`);
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Short cross-process critical section: no stale file descriptor after rename. */
function locked<T>(path: string, action: () => T): T {
  const lock = `${path}.lock`;
  let fd: number | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, `${process.pid}\n`);
      break;
    } catch (error) {
      if (fd !== undefined) { closeSync(fd); unlinkSync(lock); throw error; }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = regular(lock);
      if (!stat) continue;
      let owner = "";
      try { owner = readFileSync(lock, "utf8").trim(); } catch { continue; }
      const pid = Number(owner);
      const abandoned = /^\d+$/.test(owner) && pid > 0 && !alive(pid);
      const incomplete = owner === "" && Date.now() - Number(stat.mtimeMs) > 30_000;
      if (abandoned || incomplete) {
        const current = regular(lock);
        if (current?.ino === stat.ino && current?.dev === stat.dev) {
          try { unlinkSync(lock); } catch { /* another recovering writer won */ }
        }
      } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
    }
  }
  if (fd === undefined) throw new Error(`diagnostic file is busy: ${path}`);
  const owned = fstatSync(fd);
  try { return action(); }
  finally {
    closeSync(fd);
    const current = regular(lock);
    if (current?.ino === owned.ino && current?.dev === owned.dev) unlinkSync(lock);
  }
}

/** Returns the redacted/bounded record that actually reached disk. */
const normalizedPaths = new Set<string>();

function normalizeExisting(path: string, maxBytes: number): void {
  if (!regular(path)) return;
  const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`not a regular diagnostic file: ${path}`);
    if (process.platform !== "win32") fchmodSync(fd, 0o600);
    if (stat.size <= maxBytes) return;
    const marker = Buffer.from("[older diagnostic content removed by retention]\n");
    const tail = Buffer.alloc(maxBytes - marker.length);
    const size = readSync(fd, tail, 0, tail.length, stat.size - tail.length);
    const newline = tail.subarray(0, size).indexOf(10);
    // Only complete records: no partial credentials or broken UTF-8 suffix.
    const keep = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1, size);
    ftruncateSync(fd, 0);
    writeSync(fd, Buffer.concat([marker, keep]));
  } finally { closeSync(fd); }
}

export function appendDiagnostic(path: string, value: string, limits: LogLimits = {}): string {
  const maxBytes = limits.maxBytes ?? LOG_MAX_BYTES;
  const files = limits.files ?? LOG_FILE_COUNT;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 128 || !Number.isSafeInteger(files) || files < 1 || files > 20) {
    throw new Error("invalid diagnostic log limits");
  }
  const record = diagnosticRecord(value, maxBytes);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  return locked(path, () => {
    const key = `${path}:${maxBytes}:${files}`;
    if (!normalizedPaths.has(key)) {
      for (let i = 0; i < files; i++) normalizeExisting(i === 0 ? path : `${path}.${i}`, maxBytes);
      normalizedPaths.add(key);
    }
    const current = regular(path);
    if (current && Number(current.size) + Buffer.byteLength(record) > maxBytes) {
      // Validate every exact target before changing any of them.
      for (let i = 1; i < files; i++) regular(`${path}.${i}`);
      if (files === 1) unlinkSync(path);
      else {
        if (regular(`${path}.${files - 1}`)) unlinkSync(`${path}.${files - 1}`);
        for (let i = files - 2; i >= 1; i--) {
          if (regular(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        }
        renameSync(path, `${path}.1`);
      }
    }
    const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new Error(`not a regular diagnostic file: ${path}`);
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
      appendFileSync(fd, record);
    } finally { closeSync(fd); }
    return record;
  });
}
