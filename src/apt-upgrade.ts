/**
 * What a whole-machine `apt full-upgrade` would move backwards, and
 * whether this machine asked for that.
 *
 * `apt-get full-upgrade -y` refuses outright the moment its plan
 * contains a single downgrade:
 *
 *     E: Packages were downgraded and -y was used without --allow-downgrades
 *
 * One package is enough to stop the other fifty, which is how a machine
 * stops receiving kernels and security updates because of a browser.
 *
 * Passing `--allow-downgrades` unconditionally is the wrong correction:
 * it hands apt permission to move any package backwards, which is a
 * decision belonging to whoever owns the machine, and the whole reason
 * `--system` has to be typed rather than implied.
 *
 * There is a third answer, and apt already publishes it. A pin above
 * 1000 means, in `apt_preferences(5)`'s own words, that the version is
 * installed *even if this constitutes a downgrade*. A machine carrying
 * such a pin has already said what it wants; the refusal above is not
 * apt disagreeing, it is `-y` declining to answer a question the
 * operator answered in a file. The one this was written for is Ubuntu's
 * Firefox: the installed package is the snap stub `1:1snap1-0ubuntu5`,
 * whose epoch makes it sort above every real release, and the candidate
 * is the mozillateam PPA's actual browser at priority 1001.
 *
 * So the flag is passed exactly when every downgrade in the plan is one
 * of those, each named on screen with the priority that explains it, and
 * a downgrade nothing pinned stops the run and is reported by name.
 *
 * Everything here is pure over the text apt prints; src/providers.ts
 * runs the simulation and the policy queries. Both are read in `C`,
 * because these words are translated and a machine in another locale
 * must not silently parse zero downgrades out of a plan that has one.
 */

/** One package a full upgrade would move backwards. */
export interface AptDowngrade {
  name: string;
  /** The version installed now, as apt spells it. */
  from: string;
  /** The version apt would put there instead. */
  to: string;
  /**
   * The candidate's pin priority, or null when apt did not say.
   *
   * Null is the honest answer for a package whose policy could not be
   * read, and it is treated as unexplained: a downgrade this code
   * cannot account for is not one it may authorise.
   */
  priority: number | null;
}

/**
 * The priority above which apt itself documents a downgrade as intended
 * — `apt_preferences(5)`: "causes a version to be installed even if this
 * constitutes a downgrade of the package".
 */
export const DOWNGRADE_PIN = 1000;

/**
 * The packages `apt-get -s full-upgrade` says it would downgrade. PURE.
 *
 * apt prints them as a block: a header line ending in `DOWNGRADED:`
 * followed by indented package names, several to a line, until a line
 * that is not indented. Singular and plural headers both occur, so the
 * match is on the shouted word rather than on the sentence around it.
 */
export function plannedDowngrades(simulation: string): string[] {
  const lines = simulation.split(/\r?\n/);
  const start = lines.findIndex((line) => /will be DOWNGRADED:\s*$/.test(line));
  if (start < 0) return [];

  const names: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    names.push(...line.trim().split(/\s+/).filter((name) => name.length > 0));
  }
  return names;
}

/** What `apt-cache policy <pkg>` says about the version it would install. */
export interface AptPolicy {
  installed: string | null;
  candidate: string | null;
  /** The candidate's priority in the version table, or null. */
  priority: number | null;
}

/**
 * Read one package's policy. PURE.
 *
 * The priority is the one on the candidate's own row of the version
 * table, not the highest in the file: a package can be pinned in several
 * places and only the row apt would install from explains what apt is
 * about to do. The row is `[***] <version> <priority>`, with the stars
 * marking the installed version rather than the chosen one.
 */
export function aptPolicy(policy: string): AptPolicy {
  const field = (name: string): string | null => {
    const match = new RegExp(`^\\s*${name}:\\s*(\\S+)\\s*$`, "m").exec(policy);
    const value = match?.[1] ?? null;
    // apt prints "(none)" for a package it has no such version of.
    return value === null || value === "(none)" ? null : value;
  };

  const candidate = field("Candidate");
  let priority: number | null = null;
  if (candidate !== null) {
    for (const line of policy.split(/\r?\n/)) {
      const row = /^\s*(?:\*\*\*\s+)?(\S+)\s+(\d+)\s*$/.exec(line);
      if (row && row[1] === candidate) {
        priority = Number(row[2]);
        break;
      }
    }
  }
  return { installed: field("Installed"), candidate, priority };
}

/** One downgrade, as the plan and the policy together describe it. */
export function downgradeOf(name: string, policy: AptPolicy): AptDowngrade {
  return {
    name,
    from: policy.installed ?? "an unread version",
    to: policy.candidate ?? "an unread version",
    priority: policy.priority,
  };
}

/** Whether this machine's own pin is what asks for the version to go back. */
export function pinnedDowngrade(downgrade: AptDowngrade): boolean {
  return downgrade.priority !== null && downgrade.priority > DOWNGRADE_PIN;
}

export type FullUpgradePlan =
  /** Nothing in the plan goes backwards. */
  | { kind: "clean"; argv: string[]; downgrades: [] }
  /** Every downgrade is one the machine pinned above 1000. */
  | { kind: "pinned"; argv: string[]; downgrades: AptDowngrade[] }
  /** At least one downgrade nothing on this machine asked for. */
  | { kind: "refused"; downgrades: AptDowngrade[]; unexplained: AptDowngrade[] };

/** The command a whole-machine upgrade runs, before any of this. */
export const FULL_UPGRADE_ARGV: readonly string[] = [
  "sudo",
  "-E",
  "apt-get",
  "full-upgrade",
  "-y",
];

/**
 * What to run, given what the simulation and the policies said. PURE.
 *
 * All-or-nothing on the flag, because `--allow-downgrades` is not per
 * package: granting it for a pinned Firefox would grant it for the
 * unpinned package beside it in the same plan. One unexplained
 * downgrade therefore refuses the run rather than authorising both —
 * and says which package, because "apt refused" is not something anyone
 * can act on.
 */
export function fullUpgradePlan(downgrades: readonly AptDowngrade[]): FullUpgradePlan {
  if (downgrades.length === 0) return { kind: "clean", argv: [...FULL_UPGRADE_ARGV], downgrades: [] };

  const unexplained = downgrades.filter((downgrade) => !pinnedDowngrade(downgrade));
  if (unexplained.length > 0) return { kind: "refused", downgrades: [...downgrades], unexplained };

  return {
    kind: "pinned",
    argv: [...FULL_UPGRADE_ARGV, "--allow-downgrades"],
    downgrades: [...downgrades],
  };
}

/** How one pinned downgrade reads on screen. PURE. */
export function downgradeLine(downgrade: AptDowngrade): string {
  return (
    `${downgrade.name} ${downgrade.from} -> ${downgrade.to} — pinned at ` +
    `${downgrade.priority}, which apt reads as "install even if it is a downgrade"`
  );
}

/** How one unexplained downgrade reads on screen. PURE. */
export function refusedLine(downgrade: AptDowngrade): string {
  const pin = downgrade.priority === null
    ? "and apt-cache policy did not say why"
    : `and its priority is ${downgrade.priority}, at or under ${DOWNGRADE_PIN}`;
  return `${downgrade.name} would go ${downgrade.from} -> ${downgrade.to}, ${pin}`;
}
