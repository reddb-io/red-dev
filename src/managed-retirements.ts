import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync, chmodSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface RetiredDefinition {
  path: string;
  /** null retires a complete owned file; undefined preserves an unknown owner. */
  retire: (content: string) => string | null | undefined;
}
export interface RetirementChange {
  path: string;
  before: string;
  after: string | null;
}
export interface RetirementPlan {
  changes: RetirementChange[];
  preserved: string[];
}

/** Deletions require evidence from the current file, independent of migration ledgers. */
export function planRetirement(definitions: readonly RetiredDefinition[]): RetirementPlan {
  const changes: RetirementChange[] = [];
  const preserved: string[] = [];
  for (const definition of definitions) {
    if (!existsSync(definition.path)) continue;
    const stat = lstatSync(definition.path);
    if (!stat.isFile() || stat.isSymbolicLink()) { preserved.push(definition.path); continue; }
    const before = readFileSync(definition.path, "utf8");
    const after = definition.retire(before);
    if (after === undefined) preserved.push(definition.path);
    else if (after !== before) changes.push({ path: definition.path, before, after });
  }
  return { changes, preserved };
}

/** Archive exact bytes before removing or editing only proven managed definitions. */
export function applyRetirement(plan: RetirementPlan, backupRoot: string): string[] {
  const retired: string[] = [];
  for (const change of plan.changes) {
    if (!lstatSync(change.path).isFile() || lstatSync(change.path).isSymbolicLink() ||
      readFileSync(change.path, "utf8") !== change.before) {
      throw new Error(`retirement input changed: ${change.path}`);
    }
    const digest = createHash("sha256").update(change.path).update("\0").update(change.before).digest("hex");
    const backup = join(backupRoot, `${basename(change.path)}.${digest}`);
    mkdirSync(dirname(backup), { recursive: true, mode: 0o700 });
    if (!existsSync(backup)) {
      copyFileSync(change.path, backup);
      chmodSync(backup, 0o600);
    } else if (!lstatSync(backup).isFile() || lstatSync(backup).isSymbolicLink() || readFileSync(backup, "utf8") !== change.before) {
      throw new Error(`retirement backup does not match: ${backup}`);
    }
    if (change.after === null) unlinkSync(change.path);
    else writeFileSync(change.path, change.after);
    retired.push(change.path);
  }
  return retired;
}
