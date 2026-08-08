/**
 * Work that needed administrator, and did not get it, has to outlive the
 * run that gave up on it.
 *
 * The converge already says the right thing at the right moment: the
 * item that could not raise its rights warns, names the remedy, and the
 * run carries on with everything else — which is correct, because one
 * item short is not a reason to abandon thirty-five that succeeded. What
 * was missing is everything after that. The warning scrolls past, the
 * summary reports success, and from then on the machine's own account of
 * itself is silent about a port that was never opened.
 *
 * doctor is where a machine says what is wrong with it, so that is where
 * this belongs, and the shape is one the file already uses: a hotkey is
 * reported on whether Windows *accepted* it, not on whether the shortcut
 * was written, because writing without effect is the failure worth
 * catching. Privileged work is the same failure with a different cause.
 *
 * What these pin, in the order they would hurt if they broke:
 *
 *   Each outstanding item is named. A count sends the reader back to a
 *   transcript to find out which one, and the whole point is to answer
 *   that here.
 *
 *   Silence is not success. A probe that could not reach the machine
 *   reports that it could not, rather than inventing either verdict —
 *   the same discipline the hotkey check keeps around "held".
 *
 *   The remedy is asked for, never written. rights.ts owns the sentence;
 *   a second copy here would be the drift that slice just removed.
 */

import { describe, expect, test } from "bun:test";
import { checkPrivilegedWork, privilegedDrift } from "./drift.ts";
import type { Capabilities, Platform } from "./platform.ts";
import { missingRights } from "./rights.ts";
import { readFileSync } from "node:fs";

function platform(over: Partial<Platform> = {}): Platform {
  const caps: Capabilities = {
    apt: true,
    gui: false,
    systemd: true,
    winget: false,
    flatpak: false,
    ...(over.caps ?? {}),
  };
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "wsl",
    arch: "x64",
    ...over,
    caps,
  };
}

const WSL = platform();
const WINDOWS = platform({
  os: "windows",
  env: "windows",
  distro: null,
  version: null,
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
});

describe("privileged work left unfinished", () => {
  test("is drift, and every outstanding item is named", () => {
    // Two, because one item can be named by accident — a message that
    // says "ssh-server" and a message that lists what is outstanding are
    // indistinguishable until there is a second thing to list.
    const check = privilegedDrift(["ssh-server", "windows-firewall"], {
      "ssh-server": "unfinished",
      "windows-firewall": "unfinished",
    });

    expect(check.status).toBe("drift");
    expect(check.detail).toContain("ssh-server");
    expect(check.detail).toContain("windows-firewall");
  });

  test("and the finished ones are left out of it", () => {
    // A report that names an item which is already done teaches the
    // reader to stop trusting the list.
    const check = privilegedDrift(["ssh-server", "windows-firewall"], {
      "ssh-server": "finished",
      "windows-firewall": "unfinished",
    });

    expect(check.status).toBe("drift");
    expect(check.detail).toContain("windows-firewall");
    expect(check.detail).not.toContain("ssh-server");
  });

  test("says what the operator must do to clear it", () => {
    const check = privilegedDrift(["ssh-server"], { "ssh-server": "unfinished" });

    // Asked for rather than written. The operator has already read this
    // sentence once, in the converge that stopped at the item — hearing
    // it worded differently here would read as a different problem.
    expect(check.fix).toBe(missingRights("administrator").remedy);
  });
});

describe("privileged work that is done", () => {
  test("is not drift", () => {
    const check = privilegedDrift(["ssh-server", "windows-firewall"], {
      "ssh-server": "finished",
      "windows-firewall": "finished",
    });

    expect(check.status).toBe("ok");
    expect(check.fix).toBeUndefined();
  });

  test("and a machine whose plan has no privileged items is not drift either", () => {
    // Every Ubuntu target. Nothing in its plan asks for administrator —
    // apt goes through sudo, which is a path of its own — so a check
    // that reported drift here would be permanent noise on the majority
    // of machines this runs on.
    expect(privilegedDrift([], {}).status).toBe("n/a");
  });

  test("and an item nothing could ask about is reported as unasked", () => {
    // Not drift and not ok. An unreachable host, a probe that failed,
    // an item this build has no way to verify: all of them mean the
    // question went unanswered, and answering it anyway is how a doctor
    // starts lying in one direction or the other.
    const check = privilegedDrift(["ssh-server"], { "ssh-server": "unknown" });

    expect(check.status).toBe("n/a");
    expect(check.detail).toContain("ssh-server");
  });
});

describe("the check on a real target", () => {
  test("takes its items from the manifest, so Windows reports its own", async () => {
    // The states are supplied, so this asks nothing of the machine it
    // runs on — the item list is the manifest's answer for a Windows
    // target, which is where the only privileged column lives.
    const check = await checkPrivilegedWork(WINDOWS, { "ssh-server": "unfinished" });

    expect(check.status).toBe("drift");
    expect(check.detail).toContain("ssh-server");
  });

  test("and a WSL target has nothing to report, without asking anything", async () => {
    // No states passed on purpose: an empty plan must short-circuit
    // before any probe, or every doctor run on Linux would pay for a
    // question with no possible answer.
    expect((await checkPrivilegedWork(WSL)).status).toBe("n/a");
  });

  test("and doctor actually runs it", () => {
    // The half that is easy to leave out: a check nothing calls is a
    // check that passes forever.
    expect(readFileSync("src/drift.ts", "utf8")).toContain("await checkPrivilegedWork(p)");
  });
});
