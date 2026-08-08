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

import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { classifyRights, missingRights } from "./rights.ts";

/** Ran, and what it printed. */
interface Ran {
  ok: boolean;
  out: string;
}

async function run(cmd: string[]): Promise<Ran> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
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
  const install = await run(["sudo", "-n", "apt-get", "install", "-y", "openssh-server"]);
  if (!install.ok) {
    // Same wording as the rest of the converge, and now literally the
    // same wording: sudo that needs a password cannot be answered from
    // here, and that is not a bug. `sudo -n` is the same non-blocking
    // probe the shared gate uses, so a failure here means the gate.
    const denied = missingRights("sudo");
    log.warn(`openssh-server: ${denied.cause}`);
    log.plain(`       ${denied.remedy}`);
    return;
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
 */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'

$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server*' |
  Select-Object -First 1
if (-not $cap) { 'openssh-capability-missing'; exit 0 }

if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name $cap.Name | Out-Null
  "installed $($cap.Name)"
} else {
  'capability already installed'
}

# Automatic, not Manual: the capability leaves it Manual, which survives
# exactly until the next reboot.
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
`.trim();

/**
 * Windows, reached from either side of the WSL boundary.
 *
 * Under WSL this configures the *Windows host*, which is the only place
 * an inbound connection can land: WSL2 sits behind a NAT and a sshd
 * inside the distro is unreachable from the network without a port
 * proxy nobody asked for.
 */
export async function installSshServerWindows(p: Platform): Promise<void> {
  if (p.os !== "windows" && p.env !== "wsl") {
    log.skip("the Windows OpenSSH server needs a Windows host");
    return;
  }

  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", WINDOWS_SCRIPT], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();

  if ((await proc.exited) !== 0) {
    const err = (await new Response(proc.stderr).text()).trim();

    // Adding a capability is an administrator operation, and a converge
    // started from an unelevated shell is the common case rather than a
    // mistake. Asked of the one classifier so this reads exactly like
    // every other item that runs out of rights, instead of handing the
    // operator the first line of a DISM stack trace to decode.
    const denied = classifyRights(err, "administrator");
    if (denied) {
      log.warn(`the OpenSSH server: ${denied.cause}`);
      log.plain(`       ${denied.remedy}`);
      return;
    }

    // Anything else really is a failure, and keeps its own reporting.
    const first = err.split("\n")[0] ?? "unknown";
    log.warn(`could not configure the OpenSSH server: ${first}`);
    return;
  }

  for (const line of out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    log.plain(`       ${line}`);
  }
  log.ok("OpenSSH server configured on the Windows host");
}

/** The manifest entry point; picks the half this platform has. */
export async function installSshServer(p: Platform): Promise<void> {
  if (p.os === "windows") return installSshServerWindows(p);
  return installSshServerLinux(p);
}
