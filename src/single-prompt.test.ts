/**
 * Elevation is raised in one place, and the build is what says so.
 *
 * The single-prompt guarantee is not a property of any one module: it is
 * a property of every module *except* one doing nothing. That is the
 * hardest kind of rule to keep, because keeping it looks exactly like
 * not having thought about it. Eleven modules invoked PowerShell and
 * none of them elevated, which read as a design until the SSH server
 * arrived needing administrator and nothing anywhere went red.
 *
 * So the absence is written down here. A module that reaches for a
 * consent prompt of its own fails this test until somebody either moves
 * its privileged half into the batch or argues for it in the table
 * below — and arguing for it means typing a sentence next to its name,
 * which is a different act from adding one more `-Verb RunAs`.
 *
 * ## What counts as elevating
 *
 * The prompt, not the privilege. `Add-WindowsCapability` needs
 * administrator and raises nothing — run it unelevated and it fails with
 * access denied, which is an outcome the converge already knows how to
 * report. `Start-Process -Verb RunAs` is the opposite: it needs no
 * rights at all and interrupts the operator every time. Only the second
 * one breaks the guarantee, so only the second one is a tell here.
 * (manifest.test.ts owns the first question — which items *need*
 * administrator, and whether the manifest admits it.)
 *
 * sudo is deliberately not a tell. On Ubuntu it is the declared path,
 * every provider uses it, and it prompts once per session rather than
 * once per item. pkexec is, because it is a graphical prompt in the
 * middle of a converge — the Linux spelling of the thing this forbids.
 *
 * ## Scope
 *
 * src/ only: those are the modules a converge runs. scripts/ is
 * developer tooling that never reaches an operator's machine, and the
 * PowerShell in boot.ps1 is a bootstrap the operator invoked directly,
 * not an item in a plan.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { itemsNeedingAdmin } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { batchScript } from "./privileged.ts";

/**
 * The spellings of "ask the operator for rights, right now".
 *
 * Matched against code rather than guessed at: each one is a call that
 * puts a dialog in front of somebody. A spelling missing from this list
 * is a gap, not a false pass elsewhere — the list is only ever the
 * reason a module *is* reported.
 */
const ELEVATION_TELLS: RegExp[] = [
  /-Verb\s+['"`]?runas/i,
  /\bVerb\s*=\s*['"]runas['"]/i,
  /\brunas\.exe\b/i,
  /\bpkexec\b/,
  /\bgksudo\b|\bgksu\b/,
];

/**
 * The modules allowed to raise one, and why.
 *
 * A record rather than a list because the reason is the point. An
 * exemption with nothing written beside it is indistinguishable from a
 * name somebody added to make a red build green.
 */
const EXEMPT: Record<string, string> = {
  "privileged.ts":
    "The shared batch. This is the one prompt: every declared privileged item of a " +
    "run is composed into a single script and elevated once, at the end.",
  "keys.ts":
    "The elevated-shell action, fired from the keys viewer. Here the prompt is the " +
    "act rather than an interruption of one: somebody read `Elevated shell` on a " +
    "list and pressed enter, and the consent they get is the same one the " +
    "Ctrl+Alt+Shift+T shortcut raises through byte 21 of its .lnk. Nothing is being " +
    "converged, so there is no batch to defer it into — deferring it would mean " +
    "answering a request for a shell by scheduling one.",
  "wsl.ts":
    "The machine-wide font repair, which predates the guarantee and is the one " +
    "second prompt still in the tree. It fires only on a machine where the per-user " +
    "install landed and Windows still cannot see the family — rare, and it announces " +
    "itself before asking. Listed here so it stays at one rather than becoming the " +
    "precedent for the next.",
};

/** Where the modules a converge runs live. */
const SRC = import.meta.dir;

/**
 * A module's code with its comments removed.
 *
 * privileged.ts explains the prompt it raises at length, and wsl.ts
 * explains the one it raises too. A prose mention is not a call —
 * without this, documenting the rule would be enough to break it.
 */
function codeOf(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Does this code raise a consent prompt of its own? PURE. */
function elevatesOnItsOwn(code: string): boolean {
  return ELEVATION_TELLS.some((tell) => tell.test(code));
}

/**
 * Every module in a directory that elevates without being allowed to.
 *
 * The exemption is applied by file name, here, which is what makes it
 * explicit: a module is quiet because the table says so, never because
 * of what it happens to contain.
 */
function selfElevating(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => !(f in EXEMPT))
    .filter((f) => elevatesOnItsOwn(codeOf(`${dir}/${f}`)))
    .sort();
}

/** Modules written to a scratch directory, to be scanned like real ones. */
const planted: string[] = [];
function plant(files: Record<string, string>): string {
  const dir = mkdtempSync(`${tmpdir()}/red-dev-single-prompt-`);
  planted.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(`${dir}/${name}`, body);
  return dir;
}
afterAll(() => {
  for (const dir of planted) rmSync(dir, { recursive: true, force: true });
});

/** A provider that does privileged work the way the batch expects. */
const QUIET = `
export async function apply(): Promise<void> {
  await run(["powershell.exe", "-NoProfile", "-Command",
    "Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0"]);
}
`;

/** The same provider, deciding to ask for rights by itself. */
const LOUD = `
export async function apply(): Promise<void> {
  await run(["powershell.exe", "-NoProfile", "-Command",
    "Start-Process powershell.exe -Verb RunAs -ArgumentList '-Command','Add-WindowsCapability'"]);
}
`;

describe("elevation happens in one place", () => {
  test("no module outside the batch raises its own prompt", () => {
    expect(selfElevating(SRC)).toEqual([]);
  });

  test("the batch is exempt, by name and with a reason", () => {
    // Named rather than inferred: the batch is not quiet because of
    // where it sits or what it imports, it is quiet because this says so.
    expect(Object.keys(EXEMPT)).toContain("privileged.ts");
    for (const [file, reason] of Object.entries(EXEMPT)) {
      expect([file, reason.length > 40]).toEqual([file, true]);
    }
  });

  test("and no exemption outlives the code it excuses", () => {
    // An exemption for a module that has stopped elevating is a licence
    // nobody asked for, sitting where the next module will find it.
    for (const file of Object.keys(EXEMPT)) {
      expect([file, elevatesOnItsOwn(codeOf(`${SRC}/${file}`))]).toEqual([file, true]);
    }
  });
});

describe("a provider that elevates on its own", () => {
  test("turns this red", () => {
    const dir = plant({ "quiet-provider.ts": QUIET, "loud-provider.ts": LOUD });
    expect(selfElevating(dir)).toEqual(["loud-provider.ts"]);
  });

  test("is caught for the prompt, not for needing administrator", () => {
    // The quiet one runs a cmdlet that plainly needs rights it does not
    // have. That is a manifest question and an access-denied message,
    // not an interruption, so it passes here.
    const dir = plant({ "quiet-provider.ts": QUIET });
    expect(selfElevating(dir)).toEqual([]);
  });

  test("cannot hide behind a comment about the batch", () => {
    const dir = plant({
      "talkative-provider.ts": `/** Unlike Start-Process -Verb RunAs, this asks nobody. */\n${QUIET}`,
    });
    expect(selfElevating(dir)).toEqual([]);
  });

  test("and cannot inherit the batch's exemption by copying it", () => {
    // Byte-identical bodies, one named privileged.ts and one not. Only
    // the name decides — which is the whole of the exemption.
    const dir = plant({ "privileged.ts": LOUD, "copy-of-privileged.ts": LOUD });
    expect(selfElevating(dir)).toEqual(["copy-of-privileged.ts"]);
  });
});

describe("the batch it is all funnelled into", () => {
  const WINDOWS: Platform = {
    os: "windows",
    distro: null,
    version: null,
    codename: null,
    env: "windows",
    arch: "x64",
    caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
  };

  test("raises no second prompt inside the first", async () => {
    // The sections are contributed by the providers, so a provider that
    // elevates inside the script that is already elevated would nest a
    // UAC dialog in a process that has the rights already.
    const script = await batchScript(itemsNeedingAdmin(WINDOWS), "C:\\Temp\\r.txt");
    expect(elevatesOnItsOwn(script)).toBe(false);
  });
});
