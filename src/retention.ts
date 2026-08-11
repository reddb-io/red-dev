export interface RetainedFile {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
}

export interface RetentionPolicy {
  maxCount: number;
  maxAgeMs: number;
  maxBytes: number;
}

export interface RetentionSelection {
  file: RetainedFile;
  reasons: string[];
}

/** Select derived files for removal; protected paths never become candidates. */
export function selectRetention(
  files: RetainedFile[],
  policy: RetentionPolicy,
  nowMs = Date.now(),
  protectedPaths: ReadonlySet<string> = new Set(),
): RetentionSelection[] {
  const ordered = [...files].sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const selected = new Map<string, RetentionSelection>();
  const select = (file: RetainedFile, reason: string): void => {
    if (protectedPaths.has(file.path)) return;
    const existing = selected.get(file.path);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      selected.set(file.path, { file, reasons: [reason] });
    }
  };

  for (const file of ordered) {
    if (nowMs - file.mtimeMs > policy.maxAgeMs) select(file, "older than TTL");
  }

  let remaining = ordered.filter((file) => !selected.has(file.path));
  for (const file of remaining) {
    if (remaining.length <= policy.maxCount) break;
    if (protectedPaths.has(file.path)) continue;
    select(file, "over count budget");
    remaining = remaining.filter((candidate) => candidate.path !== file.path);
  }

  let bytes = remaining.reduce((sum, file) => sum + file.size, 0);
  for (const file of remaining) {
    if (bytes <= policy.maxBytes) break;
    if (protectedPaths.has(file.path)) continue;
    select(file, "over byte budget");
    bytes -= file.size;
  }

  return [...selected.values()].sort(
    (a, b) => a.file.mtimeMs - b.file.mtimeMs || a.file.path.localeCompare(b.file.path),
  );
}
