/**
 * What a reconciliation owns, applies and can observe afterwards.
 *
 * src/red-skills-hosts.ts worked this out for the seven agent hosts: a
 * plan is the commands to issue, the files red-dev writes itself, the
 * trees it copies out of the package set and the fields it owns inside
 * files somebody else wrote; applying it discovers what it turned out to
 * own; and the digest of that state, read back off the disk, is what
 * makes the next converge able to tell "already done" from "done once and
 * then deleted".
 *
 * The companion applications need exactly the same four answers about
 * runtimes, a daemon, an editor extension and two config files. Copying
 * the machinery would give this repo two digest algorithms over the same
 * kind of state, and the day they disagreed the symptom would be a
 * companion that reconciles on every converge or one that never does —
 * neither of which points at the copy that caused it. So it lives here
 * once, and the two registries above it differ only in what they own.
 *
 * Nothing in this module knows what a host or a companion is. It knows
 * paths, fields, commands, and how to hash the result.
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

import { sha256Hex } from "./checksum.ts";
import { log } from "./log.ts";
import { readOwnedField, setOwnedField } from "./owned-config.ts";

/**
 * One command in a reconciliation.
 *
 * `optional` is what `try_run … || true` is in the shared installer, and
 * it is load-bearing rather than decorative: removing a plugin that was
 * never installed exits non-zero, and treating that as a failure would
 * leave a machine permanently unrecorded and permanently rewalked.
 */
export interface Step {
  /** The command, as argv. */
  argv: string[];
  /** A non-zero exit here is reported, and the caller carries on. */
  optional?: boolean;
}

/** A command whose failure fails the thing it belongs to. */
export function must(...argv: string[]): Step {
  return { argv };
}

/** A command whose failure is reported and stepped over. */
export function may(...argv: string[]): Step {
  return { argv, optional: true };
}

/**
 * One piece of state a reconciliation owns.
 *
 * Three kinds, because there are three ways to be responsible for
 * something. A `path` is a file or directory red-dev created, and removing
 * it is removing it. A `field` is one entry inside a file the user owns,
 * and removing it must leave the rest of that file byte for byte. A `host`
 * entry is state inside an application's own store — a marketplace
 * registration in Codex's TOML, an extension inside VS Code's — which only
 * that application's CLI can take out, and which red-dev records so it can
 * say what it asked for.
 */
export type OwnedEntry =
  | { kind: "path"; path: string }
  | { kind: "field"; file: string; pointer: string[]; onlyWhenEmpty?: boolean }
  | { kind: "block"; file: string; marker: string }
  | { kind: "host"; what: string };

/** A file red-dev writes in full. */
export interface OwnedWrite {
  path: string;
  bytes: string;
  /**
   * The mode to leave it at, where being executable is the point.
   *
   * A launcher written without it is a companion installed and
   * unrunnable, which is the same failure as a font registered and
   * unusable: the artifact is there, the path to it is not.
   */
  mode?: number;
}

/** A directory red-dev copies out of the package set in full. */
export interface OwnedCopy {
  from: string;
  to: string;
}

/** One field red-dev owns inside a file the user owns. */
export interface OwnedMerge {
  file: string;
  pointer: string[];
  value: unknown;
}

/**
 * One block red-dev owns inside a file with no object model.
 *
 * herdr's config is TOML and zellij's is KDL, and neither has an encoder
 * in this repo — nor should it, for the reason src/owned-config.ts gives
 * about rewriting a document to change one line. What both do have is a
 * comment syntax, so red-dev's half is delimited by a header it wrote and
 * ends at the first blank line after it. Everything outside that span is
 * the operator's and is never read as anything but bytes to keep.
 *
 * `guard` is how a block stands down: a config that already binds the key
 * this block would bind belongs to whoever bound it, and a converge that
 * moved somebody's shortcut out from under them would be a worse failure
 * than the feature it was trying to reach.
 */
export interface OwnedBlock {
  file: string;
  /** The header line, which is both the marker and the first line written. */
  marker: string;
  /** The whole block, starting with `marker`. */
  bytes: string;
  /** When this matches the file, the operator already owns the ground. */
  guard?: RegExp;
}

/** The part of any plan this module knows how to carry out. */
export interface OwnedWork {
  /** The commands to issue, in the order they have to be issued. */
  steps: readonly Step[];
  /** Files red-dev writes itself. */
  writes: readonly OwnedWrite[];
  /** Trees red-dev copies out of the package set. */
  copies: readonly OwnedCopy[];
  /** Fields red-dev owns inside files somebody else owns. */
  merges: readonly OwnedMerge[];
  /** Blocks red-dev owns inside files with no object model. */
  blocks?: readonly OwnedBlock[];
  /** State that must exist afterwards, which nothing above created. */
  expect: readonly OwnedEntry[];
}

/** A stable key for one owned entry, so two records can be compared. */
export function ownedKey(entry: OwnedEntry): string {
  if (entry.kind === "path") return `path:${entry.path}`;
  if (entry.kind === "field") return `field:${entry.file}#${entry.pointer.join(".")}`;
  if (entry.kind === "block") return `block:${entry.file}#${entry.marker}`;
  return `host:${entry.what}`;
}

export function dedupeOwned(entries: readonly OwnedEntry[]): OwnedEntry[] {
  const seen = new Map<string, OwnedEntry>();
  for (const entry of entries) if (!seen.has(ownedKey(entry))) seen.set(ownedKey(entry), entry);
  return [...seen.values()];
}

/** The digest of one owned entry as it exists now, or `absent`. */
export async function observeOwned(entry: OwnedEntry, witness: string): Promise<string> {
  if (entry.kind === "host") return sha256Hex(`${entry.what}\0${witness}`);
  if (entry.kind === "block") {
    if (!existsSync(entry.file)) return "absent";
    const block = readOwnedBlock(readFileSync(entry.file, "utf8"), entry.marker);
    return block === null ? "absent" : sha256Hex(block);
  }
  if (entry.kind === "field") {
    if (!existsSync(entry.file)) return "absent";
    const value = readOwnedField(readFileSync(entry.file, "utf8"), entry.pointer);
    return value === undefined ? "absent" : sha256Hex(JSON.stringify(value));
  }
  if (!existsSync(entry.path)) return "absent";
  const stat = statSync(entry.path);
  if (stat.isDirectory()) {
    const { treeDigest } = await import("./red-skills-set.ts");
    return treeDigest(entry.path);
  }
  return sha256Hex(readFileSync(entry.path));
}

/**
 * The digest of everything one reconciliation is responsible for.
 *
 * Sorted by owned key, so the same state hashes the same however the plan
 * happened to order it, and every absence is part of the digest rather than
 * invisible to it: a generated directory somebody deleted has to move this
 * number, or the next converge would skip the thing that no longer has it.
 */
export async function stateDigestOf(
  entries: readonly OwnedEntry[],
  witness: string,
): Promise<string> {
  const lines: string[] = [];
  for (const entry of entries) lines.push(`${ownedKey(entry)}\0${await observeOwned(entry, witness)}`);
  lines.sort();
  return sha256Hex(`${lines.join("\n")}\n`);
}

/** What one application's plan turned out to do. */
export interface Applied {
  /** The first hard failure, or null. */
  failure: string | null;
  /** What the plan turned out to own, discovered as it ran. */
  owned: OwnedEntry[];
}

/** Run a plan: its commands, then its files, then its owned fields. */
export async function applyOwned(
  work: OwnedWork,
  run: (cmd: string[]) => Promise<number>,
): Promise<Applied> {
  const owned: OwnedEntry[] = [];

  const failure = await runSteps(work.steps, run);
  if (failure !== null) return { failure, owned };

  try {
    for (const write of work.writes) {
      mkdirSync(dirname(write.path), { recursive: true });
      // Compare-then-write: a converge that rewrites an unchanged file is
      // a converge claiming work, and its mtime is a lie told to whoever
      // reads it next.
      if (!existsSync(write.path) || readFileSync(write.path, "utf8") !== write.bytes) {
        await Bun.write(write.path, write.bytes);
      }
      if (write.mode !== undefined) chmodSync(write.path, write.mode);
      owned.push({ kind: "path", path: write.path });
    }

    for (const copy of work.copies) {
      rmSync(copy.to, { recursive: true, force: true });
      mkdirSync(dirname(copy.to), { recursive: true });
      cpSync(copy.from, copy.to, { recursive: true });
      owned.push({ kind: "path", path: copy.to });
    }

    for (const merge of work.merges) {
      owned.push(...(await applyMerge(merge)));
    }

    for (const block of work.blocks ?? []) {
      const entry = await applyBlock(block);
      if (entry !== null) owned.push(entry);
    }
  } catch (error) {
    return { failure: `${(error as Error).message}`, owned };
  }

  owned.push(...work.expect);
  return { failure: null, owned: dedupeOwned(owned) };
}

/**
 * Splice one field into a file the user owns, and record what that cost.
 *
 * The parent object is recorded too, and only when this call had to create
 * it: removing `mcpServers` because our entry was all it ever held is
 * right, and removing it out from under a server the operator added later
 * is the exact failure the ownership manifest exists to prevent.
 */
export async function applyMerge(merge: OwnedMerge): Promise<OwnedEntry[]> {
  const before = existsSync(merge.file) ? readFileSync(merge.file, "utf8") : "";
  const parent = merge.pointer.slice(0, -1);
  const madeParent = parent.length > 0 && readOwnedField(before, parent) === undefined;
  const after = setOwnedField(before, merge.pointer, merge.value);
  if (after !== before) {
    mkdirSync(dirname(merge.file), { recursive: true });
    await Bun.write(merge.file, after);
  }
  const entries: OwnedEntry[] = [{ kind: "field", file: merge.file, pointer: [...merge.pointer] }];
  if (madeParent) entries.push({ kind: "field", file: merge.file, pointer: parent, onlyWhenEmpty: true });
  return entries;
}

/**
 * red-dev's block inside somebody else's file, or null.
 *
 * The span is the marker line through the last line before the blank one
 * that closed it, which is how the block was written and therefore the
 * only definition of it that survives an operator appending below.
 */
export function readOwnedBlock(text: string, marker: string): string | null {
  const lines = text.split("\n");
  const start = lines.indexOf(marker);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && lines[end]?.trim() !== "") end++;
  return `${lines.slice(start, end).join("\n")}\n`;
}

/**
 * Write the block, replace the one already there, or stand down.
 *
 * Answers the entry it owns afterwards, or null when it wrote nothing
 * because the operator's own configuration already claims the ground —
 * null is not a failure, and recording it as owned would mean removing
 * their line on the way out.
 */
export async function applyBlock(block: OwnedBlock): Promise<OwnedEntry | null> {
  const owned: OwnedEntry = { kind: "block", file: block.file, marker: block.marker };
  const bytes = block.bytes.endsWith("\n") ? block.bytes : `${block.bytes}\n`;

  if (!existsSync(block.file)) {
    mkdirSync(dirname(block.file), { recursive: true });
    await Bun.write(block.file, bytes);
    return owned;
  }

  const existing = readFileSync(block.file, "utf8");
  const current = readOwnedBlock(existing, block.marker);
  if (current !== null) {
    if (current === bytes) return owned;
    await Bun.write(block.file, existing.replace(current, bytes));
    return owned;
  }

  if (block.guard?.test(existing)) {
    log.skip(`${block.file} already declares this itself — left alone`);
    return null;
  }

  await Bun.write(block.file, `${existing.trimEnd()}\n\n${bytes}`);
  return owned;
}

/**
 * Take the block back out, and leave every other byte where it was.
 *
 * Answers whether there was one. A file the operator has since rewritten
 * without it is not an error on the way out — it is a file that already
 * says what removal was trying to make it say.
 */
export async function removeBlock(file: string, marker: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  const existing = readFileSync(file, "utf8");
  const block = readOwnedBlock(existing, marker);
  if (block === null) return false;
  const kept = existing.replace(block, "").trim();
  await Bun.write(file, kept === "" ? "" : `${kept}\n`);
  return true;
}

/**
 * The first owned thing that is not there, said as a person would say it.
 *
 * Null when every one of them is, which is the only state that may be
 * recorded: a record written over a half-applied plan is the stamp this
 * whole architecture replaced, under a longer name.
 */
export function missingOwned(owned: readonly OwnedEntry[]): string | null {
  for (const entry of owned) {
    if (entry.kind === "path" && !existsSync(entry.path)) return `${entry.path} was not written`;
    if (entry.kind === "field") {
      const text = existsSync(entry.file) ? readFileSync(entry.file, "utf8") : "";
      if (readOwnedField(text, entry.pointer) === undefined) {
        return `${entry.file} has no ${entry.pointer.join(".")}`;
      }
    }
    if (entry.kind === "block") {
      const text = existsSync(entry.file) ? readFileSync(entry.file, "utf8") : "";
      if (readOwnedBlock(text, entry.marker) === null) {
        return `${entry.file} carries no ${entry.marker}`;
      }
    }
  }
  return null;
}

/** Runs one plan's commands, and answers the first hard failure or null. */
export async function runSteps(
  steps: readonly Step[],
  run: (cmd: string[]) => Promise<number>,
): Promise<string | null> {
  for (const step of steps) {
    const what = step.argv.join(" ");
    let code: number;
    try {
      code = await run(step.argv);
    } catch (error) {
      if (step.optional) {
        log.warn(`${what} could not be run: ${(error as Error).message}`);
        continue;
      }
      return `${what} could not be run: ${(error as Error).message}`;
    }
    if (code === 0) continue;
    if (step.optional) {
      log.skip(`${what} exited ${code}, which this step is allowed to do`);
      continue;
    }
    return `${what} exited ${code}`;
  }
  return null;
}
