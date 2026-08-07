/**
 * Finishing a move the migration deliberately left half-done.
 *
 * `2026-08-06-share-root-namespace` copied ~/.reddev into ~/.red/dev and
 * did not delete the source, because the ledger's rule is that a
 * migration is never destructive and nothing had verified the copy. What
 * that leaves is two share roots, one of which nothing reads — and it is
 * the first thing anyone finds when they go looking for where their
 * settings live.
 *
 * pruneVerdict is the safety argument, extracted so it can be tested
 * without two real directories and a Windows profile. The rule it
 * encodes: a file may only be removed if the new root has one with
 * identical bytes, or if red-dev has since retired it on purpose. One
 * unexplained file cancels the whole prune rather than deleting the rest
 * around it — a half-pruned directory is harder to reason about than an
 * untouched one.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  legacyRoot,
  looksGenerated,
  namespaceMove,
  pruneVerdict,
  windowsProfileOf,
} from "./shared-root.ts";

const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex");

describe("pruneVerdict", () => {
  test("a file with an identical twin next door is superseded", () => {
    const v = pruneVerdict(
      [{ path: "config/bat/config", sha: sha("a") }],
      new Map([["config/bat/config", sha("a")]]),
    );
    expect(v.superseded).toEqual(["config/bat/config"]);
    expect(v.unaccounted).toEqual([]);
  });

  test("a file the new root never received is not", () => {
    const v = pruneVerdict([{ path: "config/mine.toml", sha: sha("a") }], new Map());
    expect(v.unaccounted).toEqual(["config/mine.toml"]);
    expect(v.superseded).toEqual([]);
  });

  test("same name, different bytes, is not superseded either", () => {
    // The case that matters most. A config edited in the old root after
    // the copy is the one file a prune must never take, and it is
    // indistinguishable from a superseded one by name alone.
    const v = pruneVerdict(
      [{ path: "config/bash/local.sh", sha: sha("edited by hand") }],
      new Map([["config/bash/local.sh", sha("what red-dev wrote")]]),
    );
    expect(v.unaccounted).toEqual(["config/bash/local.sh"]);
  });

  test("a file red-dev retired is superseded by its own absence", () => {
    // theme.toml and the zellij theme are gone from the new root on
    // purpose — see .red/adr/0003. Absent next door is the correct
    // state, not a copy that failed, so they must not read as
    // unaccounted and block the prune forever.
    const v = pruneVerdict(
      [
        { path: "config/alacritty/theme.toml", sha: sha("twenty ansi values") },
        { path: "config/zellij/themes/red-dev.kdl", sha: sha("a theme") },
      ],
      new Map(),
    );
    expect(v.superseded).toHaveLength(2);
    expect(v.unaccounted).toEqual([]);
  });

  test("one unexplained file leaves the others listed but the caller cancels", () => {
    // pruneVerdict reports both sets; refusing on a non-empty
    // `unaccounted` is pruneLegacyRoot's job. This pins the split so a
    // future caller cannot quietly delete the superseded ones anyway.
    const v = pruneVerdict(
      [
        { path: "config/bat/config", sha: sha("a") },
        { path: "config/secret.toml", sha: sha("mine") },
      ],
      new Map([["config/bat/config", sha("a")]]),
    );
    expect(v.superseded).toEqual(["config/bat/config"]);
    expect(v.unaccounted).toEqual(["config/secret.toml"]);
  });

  test("an empty old root is a clean prune, not a refusal", () => {
    expect(pruneVerdict([], new Map())).toEqual({ superseded: [], unaccounted: [] });
  });
});

describe("windowsProfileOf", () => {
  test("finds the profile a recorded root sits under", () => {
    expect(windowsProfileOf("C:\\Users\\filip\\.red\\dev")).toBe("C:\\Users\\filip");
  });

  test("and the legacy spelling derives from the same profile", () => {
    const profile = windowsProfileOf("C:\\Users\\filip\\.red\\dev")!;
    expect(legacyRoot(profile)).toBe("C:\\Users\\filip\\.reddev");
  });

  test("says nothing about a root outside a profile", () => {
    // D:\shared is a deliberate choice, and there is no .reddev beside
    // it to reason about. Guessing one would be inventing a directory.
    expect(windowsProfileOf("D:\\shared")).toBeNull();
  });
});

describe("the rule the prune inherits from namespaceMove", () => {
  test("a root the user pointed at .reddev on purpose is still theirs", () => {
    // namespaceMove only relocates the default this project wrote.
    // pruneLegacyRoot refuses for the same reason, by comparing the
    // legacy path against the recorded one before doing anything.
    const profile = "C:\\Users\\filip";
    expect(namespaceMove("D:\\somewhere\\.reddev", profile)).toBeNull();
  });
});

describe("looksGenerated", () => {
  test("recognises the generated-file marker", () => {
    expect(looksGenerated("# Generated by red-dev -- terminal keys.\nkey = 'V'\n")).toBe(true);
  });

  test("and the header on the dotfiles red-dev installs", () => {
    expect(looksGenerated("// red-dev — zellij.\n//\n// zellij is what makes tiling\n")).toBe(true);
  });

  test("but never local.sh, which names red-dev and belongs to the user", () => {
    // The counter-example the whole function exists for. red-dev creates
    // this file once and never writes it again, and it says so in the
    // line that also says "red-dev" — so a looser match would delete the
    // one file here that has never been safe to delete.
    const local =
      "# Yours. red-dev created this file once and will not write it again.\n" +
      "#\n# Sourced last, after everything red-dev generates, so anything here\n# wins.\n";
    expect(looksGenerated(local)).toBe(false);
  });

  test("and not a file that merely mentions red-dev further down", () => {
    expect(looksGenerated(`${"x\n".repeat(300)}Generated by red-dev\n`)).toBe(false);
  });
});

describe("an older copy of red-dev's own output", () => {
  test("is superseded when the new root has the same file", () => {
    // The case a strict byte match got wrong. Within one release
    // keys.toml gained a Shift+Enter binding and bat's config changed
    // marker, so every generated file differs and the prune would refuse
    // forever on files nobody would miss.
    const v = pruneVerdict(
      [{ path: "config/alacritty/keys.toml", sha: sha("old"), generated: true }],
      new Map([["config/alacritty/keys.toml", sha("new")]]),
    );
    expect(v.superseded).toEqual(["config/alacritty/keys.toml"]);
  });

  test("but not when the new root has no such file at all", () => {
    // Generated once, by a version that wrote something this one does
    // not. Nothing next door means nothing was verified, so it stays.
    const v = pruneVerdict(
      [{ path: "config/gone/old.conf", sha: sha("old"), generated: true }],
      new Map(),
    );
    expect(v.unaccounted).toEqual(["config/gone/old.conf"]);
  });

  test("and a user-owned file that differs is still untouchable", () => {
    const v = pruneVerdict(
      [{ path: "config/bash/local.sh", sha: sha("my aliases"), generated: false }],
      new Map([["config/bash/local.sh", sha("the template")]]),
    );
    expect(v.unaccounted).toEqual(["config/bash/local.sh"]);
  });
});

describe("the two records, and the loop they caused", () => {
  test("the legacy default is recognised as needing a re-record", () => {
    // env.sh is per-home and a WSL machine has two homes. The namespace
    // migration ran inside the distro and updated /home/me/.config;
    // C:\Users\me\.config kept saying .reddev. So the distro converged
    // on .red\dev, the Windows converge read the stale record and
    // recreated .reddev beside it, and each side undid the other —
    // silently, because neither can see the other's record.
    const move = namespaceMove("C:\\Users\\filip\\.reddev", "C:\\Users\\filip");
    expect(move).toEqual({
      from: "C:\\Users\\filip\\.reddev",
      to: "C:\\Users\\filip\\.red\\dev",
    });
  });

  test("a record already on the new spelling is left alone", () => {
    // healLegacyRecord runs on every converge, so the steady state has
    // to cost one comparison and write nothing.
    expect(namespaceMove("C:\\Users\\filip\\.red\\dev", "C:\\Users\\filip")).toBeNull();
  });

  test("case does not decide it, because Windows paths are case-insensitive", () => {
    expect(namespaceMove("C:\\Users\\Filip\\.RedDev", "C:\\Users\\filip")).not.toBeNull();
  });
});

describe("both entry points heal, not just one", () => {
  const src = readFileSync(`${import.meta.dir}/shared-root.ts`, "utf8");

  test("chooseSharedRoot heals before it reads the record", () => {
    // The bug this pins. healLegacyRecord lived only in
    // ensureSharedRoot, and chooseSharedRoot returns from its
    // already-recorded branch without ever reaching it — so the entry
    // point firstrun uses on every run reported the stale .reddev and
    // healed nothing, while the converge step further down healed it and
    // printed the right one. Two answers in one run, wrong one first.
    const heal = src.indexOf("await healLegacyRecord(p);\n\n  const current = recordedShareRoot();");
    expect(heal).toBeGreaterThan(-1);
  });

  test("ensureSharedRoot heals too, for the converge path", () => {
    expect(src).toContain("export async function ensureSharedRoot");
    const fn = src.slice(src.indexOf("export async function ensureSharedRoot"));
    expect(fn.slice(0, 200)).toContain("healLegacyRecord");
  });

  test("and healing is idempotent, because both run on every converge", () => {
    // namespaceMove returns null for a root already on the new spelling,
    // so the steady state is one comparison and no write.
    expect(namespaceMove("C:\\Users\\filip\\.red\\dev", "C:\\Users\\filip")).toBeNull();
  });
});
