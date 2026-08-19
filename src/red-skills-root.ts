/**
 * Where this machine keeps RedSkills: `~/.red/skills`.
 *
 * One leaf module, imported by everything that spells the directory,
 * so the path is decided in exactly one place. It used to be
 * `~/.red-skills` — a sibling of `~/.red` rather than a member of it —
 * which put the package set next to the namespace instead of inside it
 * while `~/.red/config.yaml`, `~/.red/state` and `~/.red/redskilled`
 * already lived under `.red`. A person looking for "the RedSkills
 * install" finds it where the rest of red-dev's state is; a person
 * cleaning a machine removes one directory rather than two.
 *
 * Everything below `~/.red/skills` keeps its shape: `current` and
 * `previous` are the pointers, `sets/<key>` the immutable revisions,
 * `versions`, `cache`, `checkouts`, `depots`, `locks` and the JSON
 * records sit beside them exactly as they did under the old name. Only
 * the root moved. See `2026-08-19-red-skills-under-red` in
 * src/migrations.ts for how a machine provisioned under the old root is
 * brought across, and why nothing is left behind at `~/.red-skills`.
 *
 * This is red-dev's directory, not mise's. mise keeps the npm payloads
 * it installs under its own `installs/` tree and red-dev composes the
 * set from there (ADR 0011); nothing here tells mise where to put
 * anything.
 */

import * as nodeFs from "node:fs";
import { join } from "node:path";

/** The segments under `$HOME`, for code that builds the path a piece at a time. */
export const RED_SKILLS_ROOT_SEGMENTS = [".red", "skills"] as const;

/** `~/.red/skills` — the one directory this machine keeps RedSkills state in. */
export function redSkillsRoot(home: string): string {
  return join(home, ...RED_SKILLS_ROOT_SEGMENTS);
}

/**
 * `~/.red/skills` with forward slashes, for the places that splice the
 * home into a shell line or a host's JSON rather than joining a path —
 * a Windows home comes in with backslashes and must not leak them there.
 */
export function redSkillsRootPosix(home: string): string {
  return `${home.replace(/\\/g, "/").replace(/\/$/, "")}/${RED_SKILLS_ROOT_SEGMENTS.join("/")}`;
}

/** `~/.red/skills/current` — the stable pointer everything else reads. */
export function redSkillsCurrent(home: string): string {
  return join(redSkillsRoot(home), "current");
}

/** `~/.red/skills/current`, forward-slashed; see redSkillsRootPosix. */
export function redSkillsCurrentPosix(home: string): string {
  return `${redSkillsRootPosix(home)}/current`;
}

/**
 * `~/.red-skills` — where the same state lived before 2026-08-19.
 *
 * Named only so the migration can find it and so doctor can say what a
 * leftover is. Nothing resolves through it any more.
 */
export function legacyRedSkillsRoot(home: string): string {
  return join(home, ".red-skills");
}

// ------------------------------------------------------------ the move

/** What relocating one machine's state from the old root came to. */
export interface RootRelocation {
  /** `moved`: the tree now lives under ~/.red/skills. `kept`: it already did. */
  outcome: "moved" | "kept" | "nothing";
  /** Symlinks whose absolute targets were rewritten from the old root to the new one. */
  relinked: string[];
  /** Records removed because they described the old location. */
  cleared: string[];
}

/**
 * Bring a machine provisioned under `~/.red-skills` across to `~/.red/skills`.
 *
 * A rename, not a copy: both roots are under the same home, so this is
 * one atomic directory move rather than a second gigabyte of package
 * sets and depots, and a rename either happens or does not — there is
 * no half-copied state to reason about. Where the filesystem refuses
 * (a home split across mounts), the old tree is left exactly where it
 * was, so the machine keeps running from the new code's empty root and
 * the next `red-dev update` acquires into it.
 *
 * Three things are absolute paths into the old root and have to be told
 * it moved. `current` and `previous` are symlinks whose targets were
 * written out in full (`/home/x/.red-skills/sets/<key>`), so they are
 * rewritten in place. The reconcile stamp names the revision the hosts
 * were wired against, and they were wired against it *at the old path*
 * — Claude's marketplace record, Codex's, the launchers red-dev wrote —
 * so it is removed, which is what makes the converge that follows this
 * migration re-register every host at the new one instead of reporting
 * them already done. The host records themselves are not touched here:
 * red-skills-hosts.ts owns them, compares each against the path red-dev
 * wants, and rewrites the ones that differ.
 *
 * Nothing is left at the old name — no symlink for whatever might still
 * spell it. The point of the move is that a home has one RedSkills
 * directory, and an alias is a second entry that looks exactly like the
 * thing it replaced. Anything red-dev wrote that named the old path is
 * rewritten by the converge (hosts, launchers); anything a person wired
 * by hand says so the first time it fails, which is how it should be.
 * RedSkills' own fallback for RED_SKILLS_INSTALL_ROOT still spells
 * `~/.red-skills`; that default is upstream's to move, and it is not
 * read through red-dev's root.
 */
export function relocateLegacyRedSkillsRoot(
  home: string,
  fs: Pick<
    typeof nodeFs,
    | "existsSync"
    | "lstatSync"
    | "mkdirSync"
    | "readdirSync"
    | "readlinkSync"
    | "renameSync"
    | "rmSync"
    | "symlinkSync"
    | "unlinkSync"
  > = nodeFs,
): RootRelocation {
  const legacy = legacyRedSkillsRoot(home);
  const root = redSkillsRoot(home);
  const none: RootRelocation = { outcome: "nothing", relinked: [], cleared: [] };

  let legacyStat: nodeFs.Stats;
  try {
    legacyStat = fs.lstatSync(legacy);
  } catch {
    return none;
  }
  // A symlink at the old name is a person's; there is no tree there to move.
  if (!legacyStat.isDirectory() || legacyStat.isSymbolicLink()) return none;

  if (fs.existsSync(root)) {
    // Both exist: the new code has already acquired into ~/.red/skills,
    // and the old tree is whatever it was. Moving it over a live root
    // would replace the revision the hosts are wired to. Leave both and
    // say so; the old one is removed by hand by someone who can see it.
    return { ...none, outcome: "kept" };
  }

  fs.mkdirSync(join(home, ".red"), { recursive: true });
  fs.renameSync(legacy, root);

  const relinked: string[] = [];
  const legacyPrefix = legacy.replace(/\\/g, "/");
  const rootPosix = root.replace(/\\/g, "/");
  // Only the pointers at the top of the root are absolute links red-dev
  // wrote; the trees beneath carry relative links or none. Walked a few
  // levels anyway, skipping what package managers own, because a link
  // that silently kept naming the old root would be one that works
  // through the alias today and breaks the day the alias is removed.
  const walk = (dir: string, depth: number): void => {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name === "node_modules" || name === ".git") continue;
      const path = join(dir, name);
      let stat: nodeFs.Stats;
      try {
        stat = fs.lstatSync(path);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(path).replace(/\\/g, "/");
        if (target === legacyPrefix || target.startsWith(`${legacyPrefix}/`)) {
          const next = `${rootPosix}${target.slice(legacyPrefix.length)}`;
          fs.unlinkSync(path);
          fs.symlinkSync(next, path, "dir");
          relinked.push(path);
        }
      } else if (stat.isDirectory() && depth > 0) {
        walk(path, depth - 1);
      }
    }
  };
  walk(root, 3);

  const cleared: string[] = [];
  const stamp = join(root, "reconciled.json");
  if (fs.existsSync(stamp)) {
    fs.rmSync(stamp, { force: true });
    cleared.push(stamp);
  }

  return { outcome: "moved", relinked, cleared };
}
