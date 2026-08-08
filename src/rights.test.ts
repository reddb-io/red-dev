/**
 * The one place that says "this could not run because it lacked rights".
 *
 * What is worth pinning here is not the shape of the code but what an
 * operator ends up reading. Three things, in order of how badly each one
 * would hurt if it drifted:
 *
 *   The Linux message. It already worked, it is what a person has
 *   learned to look for, and this slice widened the branch rather than
 *   rewriting it — so the bytes are asserted literally rather than
 *   described.
 *
 *   The Windows message exists at all. A converge on an unelevated shell
 *   used to surface whatever PowerShell said, which for this case is six
 *   lines of DISM stack trace ending in UnauthorizedAccessException.
 *   That is a generic failure. The named outcome is the fix.
 *
 *   There is exactly one of each. Eleven modules invoke PowerShell, and
 *   the reason to centralise is that eleven wordings teach the same rule
 *   eleven times — so a second copy has to fail a test, not a review.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { classifyRights, missingRights } from "./rights.ts";

const denied = readFileSync("src/fixtures/powershell-access-denied.txt", "utf8");

/**
 * A module's code with its comments removed.
 *
 * Borrowed from manifest.test.ts, and for the same reason: prose about
 * elevation is not a second copy of the classification. hotkeys.ts
 * explains which shortcut opens an elevated PowerShell, and a module
 * that documents the problem must not be charged with re-implementing
 * it.
 */
function codeOf(file: string): string {
  return readFileSync(`src/${file}`, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

function modules(): string[] {
  return readdirSync("src")
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !f.endsWith(".d.ts"))
    .sort();
}

describe("the Linux sudo outcome", () => {
  test("is byte-for-byte what it has always been", () => {
    // Literal on purpose. Composing the expectation from the same parts
    // the code composes it from would assert nothing at all, and this
    // string is the one thing in this slice that must not move.
    expect(missingRights("sudo").message).toBe(
      "sudo needs a password and nothing here can supply one.\n" +
        "      Run `sudo -v` first, then re-run red-dev — or run it as root.",
    );
  });

  test("and the gate that produces it behaves as before", () => {
    // The behaviour beside the message: root needs no probe, the probe
    // is the non-blocking `sudo -n`, the answer is remembered for the
    // rest of the run, and the outcome is still a RedError rather than
    // a warning — a converge that cannot use sudo stops.
    const providers = codeOf("providers.ts");
    expect(providers).toContain("process.getuid?.() === 0");
    expect(providers).toContain('["sudo", "-n", "true"]');
    expect(providers).toContain("sudoChecked = true");
    expect(providers).toContain('throw new RedError(missingRights("sudo").message)');
  });
});

describe("the Windows administrator outcome", () => {
  test("a fixture where elevation is unavailable is named, not generic", () => {
    // The bytes a real unelevated Add-WindowsCapability writes to
    // stderr. Before this, they reached the operator as their own first
    // line; now they resolve to the outcome that has a remedy attached.
    const outcome = classifyRights(denied, "administrator");
    expect(outcome?.gate).toBe("administrator");
    expect(outcome?.message).toBe(missingRights("administrator").message);
  });

  test("every spelling Windows uses for the same refusal", () => {
    // One product, several components, no agreement on wording. Missing
    // one of these is what sends an operator back to a stack trace.
    for (const output of [
      "Set-Service : Service 'sshd' cannot be configured due to the following error: Access is denied",
      "New-NetFirewallRule : PermissionDenied",
      "The requested operation requires elevation.",
      "Requested registry access is not allowed.",
    ]) {
      expect(classifyRights(output, "administrator")?.gate).toBe("administrator");
    }
  });

  test("a failure for any other reason stays a failure", () => {
    // The half that keeps the outcome honest. Claiming missing rights
    // for an unrelated error would send the operator to elevate a shell
    // that changes nothing, and hide the real cause behind a remedy.
    expect(classifyRights("openssh-capability-missing", "administrator")).toBeNull();
    expect(classifyRights("", "administrator")).toBeNull();
  });

  test("sudo has tells of its own, and they are not shared", () => {
    // The two gates answer the same question, and they do not answer it
    // with the same words.
    expect(classifyRights("sudo: a password is required", "sudo")?.gate).toBe("sudo");
    expect(classifyRights("sudo: no tty present and no askpass program specified", "sudo")).not
      .toBeNull();
    expect(classifyRights("Access is denied.", "sudo")).toBeNull();
  });
});

describe("both messages", () => {
  test("name what the operator must do to finish", () => {
    // The property that makes this an outcome rather than an error: a
    // person reading it knows the next thing to type, and knows that
    // doing it costs them nothing already done.
    for (const gate of ["sudo", "administrator"] as const) {
      const outcome = missingRights(gate);
      expect(outcome.remedy).toContain("re-run red-dev");
      expect(outcome.message).toBe(`${outcome.cause}\n      ${outcome.remedy}`);
    }
    expect(missingRights("sudo").remedy).toContain("sudo -v");
    expect(missingRights("administrator").remedy).toContain("elevated PowerShell");
  });

  test("and the administrator one names the command that finishes just that", () => {
    // The deferral and the way out of it are the same sentence. An
    // operator who reads "this needs administrator" on a machine where
    // everything else converged should not have to guess that finishing
    // it costs one command rather than the whole run again — and `sudo`
    // deliberately does not say it, because the privileged batch is
    // empty on every Linux target and would do nothing there.
    expect(missingRights("administrator").remedy).toContain("red-dev privileged");
    expect(missingRights("sudo").remedy).not.toContain("red-dev privileged");
  });

  test("are the same shape, so the rule is learned once", () => {
    for (const gate of ["sudo", "administrator"] as const) {
      const outcome = missingRights(gate);
      expect(outcome.cause.split("\n")).toHaveLength(1);
      expect(outcome.remedy.split("\n")).toHaveLength(1);
      expect(outcome.cause.endsWith(".")).toBe(true);
    }
  });
});

describe("it lives in one place", () => {
  /**
   * The wording the classification owns.
   *
   * A module that contains any of these has written the outcome itself
   * instead of asking for it, which is exactly the state this slice
   * ended: a converge whose answer to "why did this stop" depends on
   * which module happened to stop.
   *
   * All of them are remedy vocabulary — the sentence telling an operator
   * what to run. Saying that an item *needs* administrator is not on the
   * list and must not be: announcing the requirement before anything
   * happens is the other half of the spec, and the prompt offering to
   * install WSL says so in the question it asks.
   */
  const OWNED = [
    "sudo -v",
    "nothing here can supply one",
    "run it as root",
    "re-run red-dev",
    "elevated PowerShell",
    "PowerShell as Administrator",
  ];

  test("no second copy of the wording exists", () => {
    const offenders = modules()
      .filter((f) => f !== "rights.ts")
      .filter((f) => OWNED.some((phrase) => codeOf(f).includes(phrase)));
    expect(offenders).toEqual([]);
  });

  test("and the modules that hit it ask for the outcome", () => {
    // The other direction. Without this, deleting a call site and its
    // message together would pass the check above by saying nothing at
    // all — which is the second failure mode the spec names.
    // drift.ts is here for the same reason as the three that converge:
    // it hands the operator a remedy after the run rather than during
    // it, which is precisely where a second wording would be hardest to
    // notice and easiest to justify.
    for (const file of ["providers.ts", "ssh-server.ts", "wsl-provision.ts", "drift.ts"]) {
      expect([file, codeOf(file).includes('from "./rights.ts"')]).toEqual([file, true]);
    }
  });

  test("and nothing else classifies a refusal by hand", () => {
    // The tells belong to rights.ts too. A module matching on
    // access-denied text is a second classifier even when it borrows
    // the message from here.
    const offenders = modules()
      .filter((f) => f !== "rights.ts")
      .filter((f) => /access is denied|requires elevation|unauthorizedaccess/i.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });
});
