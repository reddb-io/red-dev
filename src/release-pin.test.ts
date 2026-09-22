/**
 * Release pins: held at one version, in both directions.
 *
 * A floor (minVersion) answers "is this new enough", which is the wrong
 * question when a *newer* release is the defect. zellij 0.44.2 introduced
 * the OSC-reply leak, so the machine that most needs to hear about it is
 * the one running 0.44.3 — and a floor is silent on exactly that machine.
 *
 * Two halves, and the pin is only real with both: the manifest asks
 * GitHub for the pinned tag instead of /releases/latest, and installState
 * stops calling a machine ok when it is on some other version.
 */

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  installedVersion,
  installState,
  isInstalled,
  isPresent,
  TOOLS,
  type Tool } from "./manifest.ts";
import { releaseApiUrl } from "./providers.ts";

describe("releaseApiUrl", () => {
  test("without a pin it is the latest release, byte for byte what it was", () => {
    expect(releaseApiUrl("jesseduffield/lazygit")).toBe(
      "https://api.github.com/repos/jesseduffield/lazygit/releases/latest",
    );
  });

  test("with a pin it is that tag, and nothing resolves to latest", () => {
    expect(releaseApiUrl("zellij-org/zellij", "v0.44.1")).toBe(
      "https://api.github.com/repos/zellij-org/zellij/releases/tags/v0.44.1",
    );
  });

  test("the tag is used verbatim, prefix and all", () => {
    // The field holds the tag as the publisher writes it, not a version
    // we decorate: zellij tags are `v0.44.1` and plenty of projects tag
    // `0.44.1`, and guessing which is a 404 waiting for the next repo.
    expect(releaseApiUrl("owner/repo", "0.44.1")).toEndWith("/releases/tags/0.44.1");
    expect(releaseApiUrl("owner/repo", "v0.44.1")).toEndWith("/releases/tags/v0.44.1");
  });
});

/**
 * `bun` rather than a manifest tool, for min-version.test.ts's reason:
 * these need a binary that is certainly present and certainly prints a
 * version, and the process running the test is exactly that.
 */
function bunPinnedAt(version: string): Tool {
  return {
    name: "bun",
    cmd: ["bun"],
    pinVersion: version,
    scope: "core",
    u24: { kind: "apt", pkg: "bun" },
    win: { kind: "skip", reason: "not under test" },
  };
}

const BUN_VERSION = installedVersion(bunPinnedAt("0.0.0")) ?? "";

describe("installState under a pin", () => {
  test("the pinned version is ok", () => {
    expect(BUN_VERSION).not.toBe("");
    expect(installState(bunPinnedAt(BUN_VERSION))).toBe("ok");
    expect(isInstalled(bunPinnedAt(BUN_VERSION))).toBe(true);
  });

  test("a version ABOVE the pin is mismatched, not ok", () => {
    // The whole point. This is the maintainer's own host on zellij
    // 0.44.3 against a pin of 0.44.1: a floor reports it present and
    // says nothing, and the bad version stays on the machine.
    const ahead = bunPinnedAt("0.0.1");
    expect(installState(ahead)).toBe("mismatched");
    expect(isInstalled(ahead)).toBe(false);
  });

  test("a version below the pin is mismatched too", () => {
    expect(installState(bunPinnedAt("999.0.0"))).toBe("mismatched");
  });

  test("a mismatched tool is still present, so it can be removed", () => {
    // Same reasoning as the floor: the uninstall list is built from
    // isPresent, and a tool that vanishes from it while sitting on disk
    // leaves no way to remove the thing being complained about.
    expect(isPresent(bunPinnedAt("0.0.1"))).toBe(true);
  });

  test("a command that is not there is absent, not mismatched", () => {
    // "absent" and "mismatched" send the reader to different places.
    const ghost = { ...bunPinnedAt("0.0.1"), cmd: ["red-dev-no-such-binary"] };
    expect(installState(ghost)).toBe("absent");
  });

  test("no pin is the state of every other tool, unchanged", () => {
    const unpinned: Tool = { ...bunPinnedAt("0.0.1"), pinVersion: undefined };
    expect(installState(unpinned)).toBe("ok");
  });
});

describe("the zellij release channel", () => {
  const zellij = TOOLS.find((t) => t.name === "zellij");

  test("uses the reddb-io fork that fixes the OSC leak", () => {
    const text = readFileSync("src/manifest.ts", "utf8");
    const at = text.indexOf('name: "zellij"');
    const comment = text.slice(Math.max(0, at - 2500), at);
    expect(comment).toContain("5174");
    expect(comment.toLowerCase()).toContain("osc");
    expect(zellij?.u24).toEqual({
      kind: "mise",
      spec: "github:reddb-io/zellij",
      alias: "zellij",
    });
  });
});

describe("every release provider", () => {
  test("is unpinned or explicitly latest", () => {
    // Both provider kinds can hold a version now, so both are counted:
    // asking only about `gh` would have gone quietly to zero when
    // zellij moved to mise, and stopped guarding anything.
    //
    // Named rather than counted. A count said "one" and would have said
    // "nine" just as happily once the RedSkills rows were pinned, which
    // is a guard that reports arithmetic instead of intent. Every pin in
    // this list is one somebody argued for in a comment beside it; a pin
    // that appears here without being added to this table is the case
    // this test exists to catch.
    const pinned = TOOLS.flatMap((t) =>
      [t.u24, t.u26, t.win]
        .filter(
          (pr) =>
            (pr?.kind === "gh" && pr.version !== undefined) ||
            (pr?.kind === "mise" && pr.version !== undefined && pr.version !== "latest"),
        )
        .map((pr) => `${t.name}@${(pr as { version?: string }).version}`),
    );

    expect([...new Set(pinned)].sort()).toEqual([]);
  });

  test("no tool declares a floor and a pin at once", () => {
    // They answer different questions and the pin wins, so declaring
    // both hides the floor rather than combining them.
    const both = TOOLS.filter((t) => t.minVersion && t.pinVersion).map((t) => t.name);
    expect(both).toEqual([]);
  });
});
