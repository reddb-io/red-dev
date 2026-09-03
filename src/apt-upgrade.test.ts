/**
 * The one downgrade that stops a whole machine from upgrading.
 *
 * `red-dev update --system` on the machine this was written from did
 * nothing at all: fifty-one packages, thirteen new ones and two kernels
 * were held up by `apt-get -y` refusing a plan that moved Firefox
 * backwards. Backwards is what the operator's own pin asked for —
 * Ubuntu ships a snap stub whose epoch sorts above every real release,
 * and the mozillateam PPA is pinned at 1001, which apt documents as
 * "install even if this constitutes a downgrade".
 *
 * The fixtures below are that machine's actual apt output, trimmed.
 * Everything here is text in and a decision out, so none of it needs
 * apt, sudo, or a machine with a browser on it.
 */

import { describe, expect, test } from "bun:test";
import {
  aptPolicy,
  downgradeLine,
  downgradeOf,
  DOWNGRADE_PIN,
  FULL_UPGRADE_ARGV,
  fullUpgradePlan,
  pinnedDowngrade,
  plannedDowngrades,
  refusedLine,
  type AptDowngrade,
} from "./apt-upgrade.ts";

const SIMULATION = `Reading package lists...
Building dependency tree...
Reading state information...
Calculating upgrade...
The following packages were automatically installed and are no longer required:
  google-cloud-cli-anthoscli linux-headers-6.8.0-138
Use 'sudo apt autoremove' to remove them.
The following NEW packages will be installed:
  linux-headers-6.8.0-139 linux-image-6.8.0-139-generic
The following packages will be upgraded:
  claude-desktop dirmngr dnsmasq-base fastfetch gnupg
The following packages will be DOWNGRADED:
  firefox
51 upgraded, 13 newly installed, 1 downgraded, 0 to remove and 4 not upgraded.
`;

const FIREFOX_POLICY = `firefox:
  Installed: 1:1snap1-0ubuntu5
  Candidate: 155.0+build1-0ubuntu0.24.04.1~mt1
  Version table:
 *** 1:1snap1-0ubuntu5 500
        500 http://br.archive.ubuntu.com/ubuntu noble/main amd64 Packages
        100 /var/lib/dpkg/status
     155.0+build1-0ubuntu0.24.04.1~mt1 1001
        1001 https://ppa.launchpadcontent.net/mozillateam/ppa/ubuntu noble/main amd64 Packages
`;

/** The same shape with an ordinary priority: a downgrade nobody asked for. */
const UNPINNED_POLICY = `somepkg:
  Installed: 2.0.0-1
  Candidate: 1.9.0-1
  Version table:
 *** 2.0.0-1 100
        100 /var/lib/dpkg/status
     1.9.0-1 500
        500 http://br.archive.ubuntu.com/ubuntu noble/main amd64 Packages
`;

describe("what the simulation says would go backwards", () => {
  test("reads the DOWNGRADED block and nothing around it", () => {
    // The blocks above it name far more packages, and every one of them
    // is being upgraded or installed rather than moved back.
    expect(plannedDowngrades(SIMULATION)).toEqual(["firefox"]);
  });

  test("a plan with nothing to downgrade answers with nothing", () => {
    const clean = SIMULATION.replace(/The following packages will be DOWNGRADED:\n  firefox\n/, "");
    expect(plannedDowngrades(clean)).toEqual([]);
    expect(plannedDowngrades("")).toEqual([]);
  });

  test("several packages, on one line or many, and the singular header", () => {
    // apt wraps the block at the terminal width and says "package" when
    // there is one of them, so neither the count nor the layout may be
    // what this keys on.
    const many = `The following packages will be DOWNGRADED:
  firefox libfoo
  libbar
6 upgraded, 0 newly installed, 3 downgraded.
`;
    expect(plannedDowngrades(many)).toEqual(["firefox", "libfoo", "libbar"]);
    expect(plannedDowngrades("The following package will be DOWNGRADED:\n  firefox\n")).toEqual([
      "firefox",
    ]);
  });

  test("the block ends where the indentation does", () => {
    // The summary line under it is not a package, and reading it as one
    // would send `apt-cache policy 51` at the machine.
    expect(plannedDowngrades(SIMULATION)).not.toContain("51");
  });
});

describe("what the policy says about the version apt would install", () => {
  test("the candidate's own priority, not the highest in the table", () => {
    // The installed row is the one wearing the stars, and it is at 500
    // here. Reading the first number would call this unpinned and stop
    // an upgrade the machine explicitly asked for.
    expect(aptPolicy(FIREFOX_POLICY)).toEqual({
      installed: "1:1snap1-0ubuntu5",
      candidate: "155.0+build1-0ubuntu0.24.04.1~mt1",
      priority: 1001,
    });
  });

  test("an ordinary package's candidate is at its archive's priority", () => {
    expect(aptPolicy(UNPINNED_POLICY).priority).toBe(500);
  });

  test("a package apt knows nothing about says so rather than guessing", () => {
    const none = "ghost:\n  Installed: (none)\n  Candidate: (none)\n  Version table:\n";
    expect(aptPolicy(none)).toEqual({ installed: null, candidate: null, priority: null });
    expect(aptPolicy("")).toEqual({ installed: null, candidate: null, priority: null });
  });
});

describe("whether red-dev lets the upgrade happen", () => {
  const firefox = downgradeOf("firefox", aptPolicy(FIREFOX_POLICY));
  const unpinned = downgradeOf("somepkg", aptPolicy(UNPINNED_POLICY));

  test("a pin above 1000 is the machine asking for it, and apt says so itself", () => {
    expect(DOWNGRADE_PIN).toBe(1000);
    expect(pinnedDowngrade(firefox)).toBe(true);
    expect(pinnedDowngrade(unpinned)).toBe(false);
    // Exactly above, not at: 1000 is "install this version even if a
    // newer one exists", and only above it means "even if it is older".
    expect(pinnedDowngrade({ ...firefox, priority: 1000 })).toBe(false);
    expect(pinnedDowngrade({ ...firefox, priority: null })).toBe(false);
  });

  test("nothing going backwards runs exactly the command it always ran", () => {
    const plan = fullUpgradePlan([]);
    expect(plan.kind).toBe("clean");
    expect(plan.kind === "clean" && plan.argv).toEqual([...FULL_UPGRADE_ARGV]);
    expect(plan.kind === "clean" && plan.argv).not.toContain("--allow-downgrades");
  });

  test("a pinned downgrade is authorised, and named", () => {
    const plan = fullUpgradePlan([firefox]);
    expect(plan.kind).toBe("pinned");
    expect(plan.kind === "pinned" && plan.argv).toEqual([
      ...FULL_UPGRADE_ARGV,
      "--allow-downgrades",
    ]);
    // The line a person reads has to carry the reason, not just the
    // fact: "firefox is being downgraded" invites the question this
    // whole file answers.
    const said = downgradeLine(firefox);
    expect(said).toContain("firefox");
    expect(said).toContain("1:1snap1-0ubuntu5");
    expect(said).toContain("155.0+build1-0ubuntu0.24.04.1~mt1");
    expect(said).toContain("1001");
  });

  test("a downgrade nothing pinned stops the run and is named", () => {
    const plan = fullUpgradePlan([unpinned]);
    expect(plan.kind).toBe("refused");
    expect(plan.kind === "refused" && plan.unexplained.map((d) => d.name)).toEqual(["somepkg"]);
    expect(refusedLine(unpinned)).toContain("somepkg");
    expect(refusedLine(unpinned)).toContain("500");
    expect(refusedLine({ ...unpinned, priority: null })).toContain("did not say why");
  });

  test("one unexplained downgrade refuses the flag for the pinned one beside it", () => {
    // `--allow-downgrades` is not per package: granting it for Firefox
    // grants it for whatever else is in the same plan, so the mixed case
    // is the refusing one.
    const plan = fullUpgradePlan([firefox, unpinned]);
    expect(plan.kind).toBe("refused");
    expect(plan.kind === "refused" && plan.downgrades).toHaveLength(2);
    expect(plan.kind === "refused" && plan.unexplained.map((d) => d.name)).toEqual(["somepkg"]);
  });

  test("a package whose policy could not be read is not one to authorise", () => {
    const unread: AptDowngrade = downgradeOf("mystery", aptPolicy(""));
    expect(unread.from).toBe("an unread version");
    expect(fullUpgradePlan([unread]).kind).toBe("refused");
  });
});
