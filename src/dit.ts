/**
 * What dit needs from the machine besides its binary.
 *
 * dit reads the hotkey from /dev/input and types through /dev/uinput,
 * so a binary alone is a program that runs and never sees a keypress.
 * The publisher's install.sh set that up alongside the download, and
 * that coupling is why dit was the one reddb-io tool the Linux column
 * kept on an installer rather than on mise: the converge saw the
 * command present and never ran the installer again, so the binary
 * stayed at whatever version install day fetched — 0.3.0 on the
 * maintainer's machine with 0.4.0 published and, worse, a mise copy of
 * 0.4.0 sitting shadowed beside it.
 *
 * So the two halves are split the way every other row is: mise owns
 * the binary and its updates, and this module owns the three things
 * mise cannot do — membership in the `input` group, the udev rule that
 * hands /dev/uinput to that group, and the GNOME Shell focus bridge dit
 * ships for Wayland. Each is idempotent and re-checked on every
 * converge, which is what makes `red-dev doctor` able to say when a
 * machine has drifted off it. The decision is pure and tested; only
 * the probes and the sudo calls touch the machine.
 */

import { existsSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

export const UINPUT_RULE_PATH = "/etc/udev/rules.d/99-uinput.rules";

/** The rule install.sh writes, verbatim — same file, same bytes. */
export const UINPUT_RULE =
  'KERNEL=="uinput", GROUP="input", MODE="0660", OPTIONS+="static_node=uinput"';

export const FOCUS_EXTENSION = "dit-focus@reddb.io";

export interface DitInputFacts {
  /** `id -nG` includes `input`. */
  inInputGroup: boolean;
  /** The udev rule file as it is on disk, or null when absent. */
  ruleText: string | null;
  /** GNOME Shell is the running desktop, so the focus bridge applies. */
  gnome: boolean;
  /** The extension's metadata.json is already in place. */
  extensionInstalled: boolean;
}

export type DitInputStep = "group" | "udev" | "extension";

/**
 * What a converge has to do, from what the machine says. PURE.
 *
 * The rule is compared by content, not by presence: a file someone
 * hand-wrote without `static_node` leaves /dev/uinput absent until the
 * module loads, which is the "works after the second reboot" report.
 */
export function ditInputPlan(facts: DitInputFacts): DitInputStep[] {
  const steps: DitInputStep[] = [];
  if (!facts.inInputGroup) steps.push("group");
  if ((facts.ruleText ?? "").trim() !== UINPUT_RULE) steps.push("udev");
  if (facts.gnome && !facts.extensionInstalled) steps.push("extension");
  return steps;
}

/** The steps that need root, which decides whether sudo is asked for at all. PURE. */
export function needsSudo(steps: readonly DitInputStep[]): boolean {
  return steps.includes("group") || steps.includes("udev");
}

function groups(): string[] {
  const proc = Bun.spawnSync(["id", "-nG"], { stdout: "pipe", stderr: "ignore" });
  return new TextDecoder().decode(proc.stdout).trim().split(/\s+/).filter(Boolean);
}

function extensionDir(): string {
  const data = process.env["XDG_DATA_HOME"] ?? `${process.env["HOME"] ?? ""}/.local/share`;
  return `${data}/gnome-shell/extensions/${FOCUS_EXTENSION}`;
}

export function readDitInputFacts(): DitInputFacts {
  return {
    inInputGroup: groups().includes("input"),
    ruleText: existsSync(UINPUT_RULE_PATH) ? readFileSync(UINPUT_RULE_PATH, "utf8") : null,
    gnome:
      (process.env["XDG_CURRENT_DESKTOP"] ?? "").includes("GNOME") &&
      Bun.which("gnome-shell") !== null,
    extensionInstalled: existsSync(`${extensionDir()}/metadata.json`),
  };
}

/** The dit binary mise placed, or whatever PATH has, or null. */
async function ditBin(): Promise<string | null> {
  const { miseToolBin } = await import("./mise-config.ts");
  return miseToolBin("dit") ?? Bun.which("dit");
}

/**
 * Keep dit in the graphical login session.
 *
 * The command is dit's own cross-platform service adapter: systemd
 * --user (or XDG autostart) on Linux and one fixed Task Scheduler entry
 * on Windows. Re-running it rewrites that same declaration, which also
 * moves an older ~/.local/bin service onto the mise-owned executable.
 */
export async function installDitAutostart(p: Platform): Promise<void> {
  if (p.os !== "windows" && (p.os !== "linux" || p.env !== "desktop")) {
    log.skip("dit autostart only applies to a graphical desktop session");
    return;
  }

  const bin = await ditBin();
  if (!bin) throw new Error("dit is not installed yet — cannot configure autostart");

  const { spawnLogged } = await import("./providers.ts");
  const code = await spawnLogged([bin, "service", "install"]);
  if (code !== 0) throw new Error(`dit service install exited ${code}`);

  // dit writes and enables the unit itself. systemd's `enable --now`
  // does not restart a unit that was already active, though, so an
  // upgrade from the old ~/.local/bin install would otherwise keep the
  // deleted executable alive until logout. try-restart is a no-op for
  // the XDG fallback and is deliberately Linux-only.
  if (p.os === "linux" && p.caps.systemd) {
    const restarted = await spawnLogged(["systemctl", "--user", "try-restart", "dit.service"]);
    if (restarted !== 0) log.warn(`dit.service restart exited ${restarted}`);
  }

  log.ok("dit autostart converged");
}

async function sudo(argv: string[]): Promise<void> {
  const { spawnLogged } = await import("./providers.ts");
  const code = await spawnLogged(["sudo", "-n", ...argv]);
  if (code !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} exited ${code}`);
}

/**
 * Converge the input side of dit. Idempotent: a machine that has all
 * three answers `skip` and asks for nothing.
 */
export async function installDitInput(p: Platform): Promise<void> {
  if (p.os !== "linux" || p.env !== "desktop") {
    log.skip("dit's input access only applies to a Linux desktop");
    return;
  }
  const steps = ditInputPlan(readDitInputFacts());
  if (steps.length === 0) {
    log.skip("dit input access in place: input group, uinput rule, focus bridge");
    return;
  }

  if (needsSudo(steps)) {
    const { requireSudo } = await import("./providers.ts");
    await requireSudo();
  }

  if (steps.includes("group")) {
    const user = userInfo().username;
    log.step(`adding ${user} to the input group`);
    await sudo(["usermod", "-aG", "input", user]);
  }

  if (steps.includes("udev")) {
    log.step(`writing ${UINPUT_RULE_PATH}`);
    await sudo(["sh", "-c", `printf '%s\\n' '${UINPUT_RULE}' > ${UINPUT_RULE_PATH}`]);
    await sudo(["udevadm", "control", "--reload"]);
    await sudo(["udevadm", "trigger"]);
  }

  if (steps.includes("extension")) {
    // Best effort and user-level: the extension is inside the dit
    // binary, so this is only possible once mise has placed it, and a
    // release from before the subcommand existed simply has none.
    const bin = await ditBin();
    if (!bin) {
      log.warn("dit is not on this machine yet; the GNOME focus bridge waits for the next converge");
    } else {
      const { spawnLogged } = await import("./providers.ts");
      log.step("installing the GNOME focus bridge dit ships");
      const code = await spawnLogged([bin, "gnome-extension", "install"]);
      if (code !== 0) log.warn(`dit gnome-extension install exited ${code} — dit still types; only terminal-aware delivery is affected`);
    }
  }

  if (steps.includes("group")) {
    log.plain("       log out and back in for the input group to take effect");
  }
  log.ok("dit input access converged");
}

/** For `doctor`: is the input side still what a converge left. */
export function inspectDitInput(p: Platform): { name: string; status: "ok" | "drift" | "n/a"; detail: string; fix?: string } {
  if (p.os !== "linux" || p.env !== "desktop") {
    return { name: "dit input", status: "n/a", detail: "Linux desktop only" };
  }
  if (!Bun.which("dit") && !existsSync(`${process.env["HOME"] ?? ""}/.local/share/mise/shims/dit`)) {
    return { name: "dit input", status: "n/a", detail: "dit not installed" };
  }
  const steps = ditInputPlan(readDitInputFacts());
  if (steps.length === 0) {
    return { name: "dit input", status: "ok", detail: "input group, uinput rule, focus bridge" };
  }
  return {
    name: "dit input",
    status: "drift",
    detail: `missing: ${steps.join(", ")}`,
    fix: "red-dev install desktop",
  };
}
