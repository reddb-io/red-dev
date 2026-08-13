/**
 * An SSH server that is actually listening, on both targets.
 *
 * A builtin rather than a row of `apt`/`winget`, because "installed" is
 * not the deliverable here. Every other tool in the manifest is a binary
 * that either exists on PATH or does not; this one is a service, and a
 * package present with nothing listening is the failure mode worth
 * guarding — the machine reports success and refuses the connection.
 *
 * The two platforms disagree about almost everything except the port:
 *
 *   Ubuntu   apt openssh-server, then systemd enables and starts it.
 *   Windows  not a package at all. OpenSSH Server is a *capability*
 *            (`Add-WindowsCapability`), the service is created stopped
 *            and set to Manual, and the firewall blocks 22 until a rule
 *            says otherwise. Three steps, none of which winget performs,
 *            which is why there is no `win: winget(...)` row for it.
 *
 * macOS is deliberately absent. Darwin fails closed in providerFor, and
 * .red/adr/0001 puts it in Phase 5 "as an adapter of the Phase 4
 * contracts, never as a third ad-hoc implementation" — which a darwin
 * branch here would be.
 *
 * ## This opens a port
 *
 * Stated plainly because the rest of red-dev does not do anything like
 * it. Installing a compiler changes what the machine can build; this
 * changes what the network can reach, and a converge is not where a
 * person expects to be asked. It is `core` by an explicit decision, and
 * the log says what happened rather than reporting a silent `ok`.
 */

import type { PrivilegedState } from "./drift.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { classifyRights } from "./rights.ts";
import { unattendedEnvironment } from "./unattended.ts";

/** Ran, and what it printed. */
interface Ran {
  ok: boolean;
  out: string;
}

async function run(cmd: string[], live = false): Promise<Ran> {
  if (live) {
    const { spawnLoggedCapture } = await import("./providers.ts");
    const result = await spawnLoggedCapture(cmd);
    return { ok: result.code === 0, out: (result.out + result.err).trim() };
  }
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: unattendedEnvironment(),
  });
  const out = (
    (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text())
  ).trim();
  return { ok: (await proc.exited) === 0, out };
}

// ------------------------------------------------------------ linux

/**
 * The unit is `ssh` on Debian and Ubuntu, `sshd` almost everywhere else.
 *
 * Asked rather than assumed: `systemctl enable ssh` on a machine that
 * calls it sshd fails with "unit not found", which reads like a broken
 * install rather than a naming difference.
 */
async function linuxUnit(): Promise<string | null> {
  for (const unit of ["ssh", "sshd"]) {
    const { ok } = await run(["systemctl", "list-unit-files", `${unit}.service`]);
    if (ok) return unit;
  }
  return null;
}

/**
 * Ubuntu, and the one case where "installed" is genuinely all we can do.
 *
 * WSL without systemd is not a broken machine — it is the default for
 * every distro that has not opted into `systemd=true` in wsl.conf. The
 * package installs, the service cannot be enabled, and saying so beats
 * both a failure and a success.
 */
export async function installSshServerLinux(p: Platform): Promise<void> {
  // -n refuses a missing credential; -E carries the unattended envelope
  // through sudo into apt, dpkg and package maintainer scripts.
  const install = await run([
    "sudo",
    "-n",
    "-E",
    "apt-get",
    "install",
    "-y",
    "openssh-server",
  ], true);
  if (!install.ok) {
    // Raised rather than warned past, and this is the item that made
    // the distinction necessary. Warning and returning left the converge
    // recording an `applied` it had not applied: the one item that
    // regularly runs out of rights reported success, and the sentence
    // explaining why it had not scrolled away with everything else.
    // Thrown, it reaches the loop, which reads the wording back and
    // reports the item as deferred — beside the failures, not among
    // them.
    const denied = classifyRights(install.out, "sudo");
    if (denied) throw new RedError(denied.message);

    // sudo refusing and apt refusing are different answers. `sudo -n`
    // says so in its own words, so anything else here is apt's — a
    // package that does not exist on this release, an archive that is
    // unreachable — and it has no remedy involving elevation. Calling it
    // one sends an operator to raise a shell that changes nothing.
    throw new RedError(`openssh-server: ${install.out.split("\n")[0] ?? "apt-get failed"}`);
  }

  if (!p.caps.systemd) {
    log.plain("       package installed; no systemd here, so nothing was started");
    log.plain("       set systemd=true in /etc/wsl.conf to have it start on boot");
    return;
  }

  const unit = await linuxUnit();
  if (!unit) {
    log.warn("openssh-server installed but neither ssh.service nor sshd.service exists");
    return;
  }

  const up = await run(["sudo", "-n", "systemctl", "enable", "--now", unit]);
  if (!up.ok) {
    log.warn(`could not enable ${unit}: ${up.out.split("\n")[0] ?? "unknown"}`);
    return;
  }
  log.ok(`sshd listening, ${unit}.service enabled at boot`);
}

// ---------------------------------------------------------- windows

/**
 * Three steps, and the middle one is the one people forget.
 *
 * Add-WindowsCapability creates the service set to Manual and stopped,
 * so a machine that only ran the first step passes every "is it
 * installed" check and still refuses connections after a reboot.
 *
 * The firewall rule is created only when absent, and named rather than
 * matched by port: Windows ships `OpenSSH-Server-In-TCP` with some
 * builds and not others, and adding a second rule for 22 each converge
 * is how a rule list becomes unreadable.
 *
 * Every step here is guarded, which is what lets the same text run
 * again after a converge that got halfway: a capability already
 * installed, a service already running and a rule already present are
 * three no-ops, not three errors.
 *
 * Exported because the privileged batch composes it with every other
 * item that needs administrator, so one consent covers all of them. That
 * is also why the missing-capability branch nests the rest instead of
 * calling `exit 0`: composed, an exit would abandon the sections after
 * this one and the report they all write at the end.
 */
export const windowsSshServerScript = `
$ErrorActionPreference = 'Stop'

$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' |
  Select-Object -First 1
if (-not $cap) {
  'openssh-capability-missing'
} else {
  if ($cap.State -ne 'Installed') {
    Add-WindowsCapability -Online -Name $cap.Name | Out-Null
    "installed $($cap.Name)"
  } else {
    'capability already installed'
  }

  # Automatic, not Manual: the capability leaves it Manual, which
  # survives exactly until the next reboot.
  Set-Service -Name sshd -StartupType Automatic
  if ((Get-Service sshd).Status -ne 'Running') {
    Start-Service sshd
    'sshd started'
  } else {
    'sshd already running'
  }

  if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' \`
      -DisplayName 'OpenSSH Server (sshd)' \`
      -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null
    'firewall rule added for TCP 22'
  } else {
    'firewall rule already present'
  }
}
`.trim();

/**
 * Windows, reached from either side of the WSL boundary.
 *
 * Under WSL this configures the *Windows host*, which is the only place
 * an inbound connection can land: WSL2 sits behind a NAT and a sshd
 * inside the distro is unreachable from the network without a port
 * proxy nobody asked for.
 *
 * ## The rights are settled before this runs
 *
 * This item is the one that exposed the gap: it used to find out it
 * needed administrator by running the script unelevated, reading the
 * refusal back out of stderr, and telling the operator to open an
 * elevated PowerShell — a requirement discovered by failing, once per
 * item, at whatever point in a converge it happened to be reached.
 *
 * The manifest declares it now (`win: admin(builtin("ssh-server"))`),
 * which is what lets `plan` print the requirement up front and the
 * batch collect the item without running it. So there are exactly two
 * ways to arrive here, and neither is unelevated: a session that
 * already holds administrator, or the elevated child, which runs the
 * script text above rather than this function. Classifying a refusal
 * here would be answering a question that was settled before the run
 * started — and an unelevated run never gets this far, because the
 * batch defers the item instead.
 */
export async function installSshServerWindows(p: Platform): Promise<void> {
  if (p.os !== "windows" && p.env !== "wsl") {
    log.skip("the Windows OpenSSH server needs a Windows host");
    return;
  }

  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", windowsSshServerScript], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();

  if ((await proc.exited) !== 0) {
    // A failure with the rights in hand is a failure: a capability the
    // build does not carry, a service that would not start, a firewall
    // that refused the rule. Raised as one, and left to the converge to
    // report — which is also where a message that does turn out to name
    // a gate is classified, in the one place that does that.
    const err = (await new Response(proc.stderr).text()).trim();
    const first = err.split("\n")[0] ?? "unknown";
    throw new RedError(`could not configure the OpenSSH server: ${first}`);
  }

  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    log.plain(`       ${line}`);
  }
  log.ok("OpenSSH server configured on the Windows host");
}

/**
 * The same three steps, asked rather than performed.
 *
 * Read-only by construction, and that is the constraint the script is
 * written around: an unelevated doctor is exactly the machine worth
 * asking, since it is the one whose converge could not finish this. So
 * the capability is not queried at all — `Get-WindowsCapability -Online`
 * needs the rights we are trying to find out are missing — and the
 * service it creates is asked instead. No sshd service means the
 * capability was never added, which is the same answer arrived at from
 * outside.
 *
 * Every condition mirrors one the install performs, in the same order,
 * because a check that verifies less than the work did will call a
 * half-configured machine done: the capability alone leaves the service
 * Manual and stopped, and Manual survives exactly until the next reboot.
 */
const WINDOWS_PROBE = `
$svc = Get-Service sshd -ErrorAction SilentlyContinue
if (-not $svc) { 'unfinished'; exit 0 }
if ($svc.StartType -ne 'Automatic') { 'unfinished'; exit 0 }
if ($svc.Status -ne 'Running') { 'unfinished'; exit 0 }
if (-not (Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue)) {
  'unfinished'; exit 0
}
'finished'
`.trim();

/**
 * Whether the privileged half of this item is actually in place.
 *
 * "unknown" is a real answer here and is returned generously: a machine
 * with no Windows host to ask, a PowerShell that is not reachable, a
 * word this build did not print itself. Guessing in either direction is
 * worse than saying the question went unanswered — doctor reports it as
 * unasked, and nobody is sent to elevate a shell over a probe that
 * simply could not run.
 */
export async function probeSshServer(p: Platform): Promise<PrivilegedState> {
  if (p.os !== "windows" && p.env !== "wsl") return "unknown";

  const exe =
    p.os === "windows" ? "powershell.exe" : (Bun.which("powershell.exe") ?? "powershell.exe");
  try {
    const { ok, out } = await run([exe, "-NoProfile", "-Command", WINDOWS_PROBE]);
    if (!ok) return "unknown";
    const answer = out.replace(/\r/g, "").trim();
    return answer === "finished" || answer === "unfinished" ? answer : "unknown";
  } catch {
    return "unknown";
  }
}

/** The manifest entry point; picks the half this platform has. */
export async function installSshServer(p: Platform): Promise<void> {
  if (p.os === "windows") return installSshServerWindows(p);
  return installSshServerLinux(p);
}
