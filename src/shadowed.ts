/**
 * Copies of a tool that are not the copy you run.
 *
 * Every tool moved to mise was installed some other way first — a
 * release asset dropped into ~/.local/bin, a vendor script, a `cargo
 * install`. None of those remove themselves, and none of them know
 * about each other. So the machine ends up with the same command in two
 * or three places and one of them wins on PATH order alone.
 *
 * This was not hypothetical when it was written. The machine it was
 * written on had tq 0.26.2 in ~/.cargo/bin and tq 0.20.0 in
 * ~/.local/bin, with 0.28.2 published — the first shadowing the second
 * for weeks, silently, and neither of them current.
 *
 * That is the failure worth naming, because of how it presents: mise
 * installs the new version, reports success, and `tq --version` keeps
 * answering with the old one. Every individual step is fine and the
 * result is wrong, which is the hardest kind of afternoon to get back.
 *
 * So this only *reports*. It never deletes: these are files a person
 * put on their own machine, sometimes deliberately — a cargo build of
 * something they are working on is not garbage — and the difference
 * between stale and intentional is not ours to guess. Naming both paths
 * and which one wins is enough to act on, and the alternative is a
 * converge that quietly removes someone's local build.
 */

import { realpathSync } from "node:fs";
import { dirname } from "node:path";

import { providerFor, type Tool } from "./manifest.ts";
import type { Platform } from "./platform.ts";

export interface ShadowedTool {
  /** The command as typed. */
  name: string;
  /** Every copy found, in PATH order — index 0 is the one that runs. */
  copies: string[];
  /** The directory mise installed into, when it is one of the copies. */
  managedDir: string | null;
}

export interface ShadowReport {
  kind: "ok" | "warning";
  name: string;
  detail: string;
  fix?: string;
}

/**
 * Find duplicates of the commands mise now owns.
 *
 * `lookup` returns every path a name resolves to, in PATH order, so the
 * whole thing stays a function of its inputs and the tests do not need
 * a machine with two copies of anything installed on it.
 */
export function findShadowed(
  p: Platform,
  lookup: (name: string) => string[],
  tools: readonly Tool[],
  managedRoot: string,
  identify: (path: string, signature: RegExp) => boolean = runIdentify,
): ShadowedTool[] {
  const out: ShadowedTool[] = [];
  for (const tool of tools) {
    const pr = providerFor(tool, p);
    if (pr.kind !== "mise") continue;

    const name = pr.alias ?? tool.name;

    // Two entries can be one file. Ubuntu merged /bin into /usr/bin, so
    // `red` resolves in both and looks like a duplicate of itself —
    // which would have this report tell someone to delete a path that
    // is the same file as the one it just told them to keep.
    const copies = dedupeByFile(lookup(name));
    if (copies.length < 2) continue;

    // A shared name is not a shared program, and the difference is not
    // academic here: Ubuntu ships GNU ed's restricted mode at
    // /usr/bin/red, so the RedDB CLI looks shadowed by a core system
    // binary. Advising its removal would be advice to break the
    // machine. Tool.signature already exists to settle exactly this
    // question — the same check installState makes before calling a
    // tool present.
    const real = tool.signature
      ? copies.filter((path) => identify(path, tool.signature as RegExp))
      : copies;
    if (real.length < 2) continue;

    const managed = real.find((c) => c.startsWith(managedRoot)) ?? null;
    out.push({ name, copies: real, managedDir: managed ? dirname(managed) : null });
  }
  return out;
}

/** Collapse paths that are the same file — symlinks, merged /usr. */
function dedupeByFile(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const path of paths) {
    let key = path;
    try {
      key = realpathSync(path);
    } catch {
      // Unreadable or dangling: keep it under its own name rather than
      // silently dropping a copy that may well be the one running.
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

/** Ask a binary what it is, the way installState does. */
function runIdentify(path: string, signature: RegExp): boolean {
  try {
    const proc = Bun.spawnSync([path, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    return signature.test(`${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`);
  } catch {
    return false;
  }
}

/**
 * Turn findings into doctor rows.
 *
 * Split from the finding so the wording is testable, and because the
 * two cases read very differently to someone scanning a report: a
 * shadowed *mise* copy is the one that silently undoes an upgrade,
 * while duplicates where mise is not involved at all are worth a
 * mention and nothing more.
 */
export function describeShadowed(found: ShadowedTool[]): ShadowReport[] {
  return found.map((s) => {
    const [winner, ...rest] = s.copies;
    const others = rest.join(", ");

    if (s.managedDir && !winner?.startsWith(s.managedDir)) {
      return {
        kind: "warning",
        name: s.name,
        detail:
          `runs from ${winner}, but mise manages a copy too — ` +
          `mise upgrade will update one you are not running`,
        fix: `remove ${winner} once you are sure nothing else needs it, then reopen the shell`,
      };
    }

    return {
      kind: "warning",
      name: s.name,
      detail: `runs from ${winner}; ${rest.length} other cop${rest.length === 1 ? "y" : "ies"} on PATH (${others})`,
      fix: `remove the copies you no longer want: ${others}`,
    };
  });
}

/** Every directory on PATH holding an executable by this name, in order. */
export function pathLookup(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env["PATH"] ?? env["Path"] ?? "";
  if (!raw) return [];
  const sep = process.platform === "win32" ? ";" : ":";
  const seen = new Set<string>();
  const out: string[] = [];

  for (const dir of raw.split(sep)) {
    if (!dir) continue;
    // Resolve against one directory at a time: Bun.which answers with
    // the winner for a whole PATH, and the winner is precisely the copy
    // this module is not interested in on its own.
    const hit = Bun.which(name, { PATH: dir });
    if (!hit || seen.has(hit)) continue;
    seen.add(hit);
    out.push(hit);
  }
  return out;
}
