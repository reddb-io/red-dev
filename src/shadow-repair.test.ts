/**
 * The copy that answers to the name, after red-dev installed another one.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkShadow, npmPackageOf, repairShadow } from "./shadow-repair.ts";

function tree(): { root: string; ours: string; theirs: string } {
  const root = mkdtempSync(join(tmpdir(), "red-shadow-"));
  const ours = join(root, "local", "bin", "redcode");
  const theirs = join(root, "node", "lib", "node_modules", "@reddb-io", "redcode", "bin", "redcode");
  mkdirSync(join(root, "local", "bin"), { recursive: true });
  mkdirSync(join(theirs, ".."), { recursive: true });
  writeFileSync(ours, "#!/bin/sh\n");
  writeFileSync(theirs, "#!/bin/sh\n");
  return { root, ours, theirs };
}

describe("which package a path belongs to", () => {
  test("a global install, scoped or not", () => {
    expect(npmPackageOf("/n/lib/node_modules/@reddb-io/redcode/bin/redcode")).toBe("@reddb-io/redcode");
    expect(npmPackageOf("/n/lib/node_modules/opencode-ai/bin/opencode")).toBe("opencode-ai");
    // Windows spelling of the same tree.
    expect(npmPackageOf("C:\\n\\lib\\node_modules\\@x\\y\\bin\\y.exe")).toBe("@x/y");
  });

  test("a path that is not npm's answers nothing", () => {
    expect(npmPackageOf("/home/cyber/.local/bin/redcode")).toBeNull();
  });
});

describe("is the copy that runs the copy we installed", () => {
  test("two entries that are one file are not a shadow", () => {
    const t = tree();
    const link = join(t.root, "local", "bin", "redcode-link");
    symlinkSync(t.ours, link);
    // Ubuntu merged /bin into /usr/bin and mise's shims point at real
    // files; a name resolving twice is not two programs.
    expect(checkShadow(link, t.ours).shadowed).toBe(false);
  });

  test("a different file first on PATH is a shadow", () => {
    const t = tree();
    expect(checkShadow(t.theirs, t.ours).shadowed).toBe(true);
  });

  test("a path that does not resolve is not called a shadow", () => {
    const t = tree();
    expect(checkShadow(null, t.ours).shadowed).toBe(false);
    expect(checkShadow(t.ours, null).shadowed).toBe(false);
  });
});

describe("clearing the field", () => {
  const base = (over: Record<string, unknown> = {}) => {
    const ran: string[][] = [];
    const t = tree();
    return {
      ran,
      t,
      opts: {
        cmd: "redcode",
        installedPath: t.ours,
        runningPath: t.theirs,
        npm: "/usr/bin/npm",
        npmGlobals: new Set(["@reddb-io/redcode"]),
        mise: "/usr/bin/mise",
        run: async (argv: string[]) => {
          ran.push(argv);
          return 0;
        },
        ...over,
      },
    };
  };

  test("an npm package npm owns, shadowing our install, goes — and the shim with it", async () => {
    const h = base();
    const result = await repairShadow(h.opts);

    expect(result.outcome).toBe("repaired");
    expect(result.reason).toContain("@reddb-io/redcode");
    expect(h.ran.map((a) => a.join(" "))).toEqual([
      "/usr/bin/npm uninstall -g @reddb-io/redcode",
      // The shim outlives the package and answers ahead of ~/.local/bin
      // exactly as the package did.
      "/usr/bin/mise reshim",
    ]);
  });

  test("nothing runs when our copy is already the one that answers", async () => {
    const h = base({ runningPath: undefined });
    const result = await repairShadow({ ...h.opts, runningPath: h.t.ours });
    expect(result.outcome).toBe("clear");
    expect(h.ran).toEqual([]);
  });

  test("a shadow npm does not own is reported with both paths, never removed", async () => {
    // Some other file wins the name. Removing software on a guess is
    // worse than the shadow it would clear.
    const h = base({ npmGlobals: new Set<string>() });
    const result = await repairShadow(h.opts);

    expect(result.outcome).toBe("reported");
    expect(result.reason).toContain(h.t.theirs);
    expect(result.reason).toContain(h.t.ours);
    expect(h.ran).toEqual([]);
  });

  test("a machine with no npm removes nothing, whatever the path looks like", async () => {
    const h = base({ npm: null });
    expect((await repairShadow(h.opts)).outcome).toBe("reported");
    expect(h.ran).toEqual([]);
  });

  test("no mise means no reshim, and the removal still happens", async () => {
    const h = base({ mise: null });
    expect((await repairShadow(h.opts)).outcome).toBe("repaired");
    expect(h.ran.map((a) => a.join(" "))).toEqual(["/usr/bin/npm uninstall -g @reddb-io/redcode"]);
  });
});
