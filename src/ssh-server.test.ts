/**
 * The SSH server, and the three things about it that are easy to get
 * wrong without noticing.
 *
 * A service is not a binary. Every other manifest entry is satisfied by
 * a file appearing on PATH, so the tests elsewhere can ask "is it
 * installed" and stop. Here the machine can pass that question and
 * still refuse every connection, so what is pinned is the shape of the
 * work rather than its outcome — the PowerShell is asserted as text
 * because the alternative is a Windows host in CI.
 *
 * macOS gets a test of its own because "we forgot" and "we decided"
 * look identical in a manifest, and .red/adr/0001 is explicit that
 * Darwin arrives in Phase 5 as an adapter and never as a special case.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { outcomeForError } from "./converge.ts";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Capabilities, Platform } from "./platform.ts";
import { batchScript, runPrivilegedBatch, type BatchHost } from "./privileged.ts";

const source = readFileSync("src/ssh-server.ts", "utf8");

const sshServer = TOOLS.find((t) => t.name === "ssh-server")!;

function platform(over: Partial<Platform> = {}): Platform {
  return {
    os: "linux",
    env: "wsl",
    arch: "x64",
    version: "24.04",
    caps: {
      apt: true,
      gui: false,
      systemd: true,
      winget: false,
      flatpak: false,
    } satisfies Capabilities,
    ...over,
  } as Platform;
}

describe("the manifest entry", () => {
  test("is core on both columns, so a converge always reaches it", () => {
    const tool = TOOLS.find((t) => t.name === "ssh-server");
    expect(tool?.scope).toBe("core");
    expect(providerFor(tool!, platform())).toEqual({
      kind: "builtin",
      name: "ssh-server",
      needsSudo: true,
    });
    // Same builtin on both, and one extra word on the Windows column:
    // the capability, the service and the firewall rule all need
    // administrator, while Ubuntu's apt-get takes the usual sudo path.
    expect(providerFor(tool!, platform({ os: "windows", env: "windows" }))).toEqual({
      kind: "builtin",
      name: "ssh-server",
      needsAdmin: true,
    });
  });

  test("is a builtin, not apt-and-winget", () => {
    // The distinction that matters: apt would report success on a WSL
    // without systemd while nothing listens, and no winget package
    // installs a Windows *capability*.
    const tool = TOOLS.find((t) => t.name === "ssh-server");
    expect(tool?.u24.kind).toBe("builtin");
    expect(tool?.win.kind).toBe("builtin");
    expect(tool?.managed).toBe(true);
  });

  test("macOS is still refused, and by the shared gate", () => {
    // Not a special case in ssh-server.ts, and not silently supported.
    const tool = TOOLS.find((t) => t.name === "ssh-server");
    expect(() => providerFor(tool!, platform({ os: "darwin" }))).toThrow(/darwin/);
    expect(source).not.toContain('"darwin"');
  });
});

describe("the Windows half", () => {
  test("sets the service to Automatic, not just Started", () => {
    // Add-WindowsCapability leaves sshd on Manual. Starting it without
    // this passes every check today and stops listening at the next
    // reboot, which is the failure that looks like a flaky machine.
    expect(source).toContain("Set-Service -Name sshd -StartupType Automatic");
    expect(source).toContain("Start-Service sshd");
  });

  test("opens the port, and only once", () => {
    // A converge runs repeatedly; an unguarded New-NetFirewallRule adds
    // a duplicate rule for TCP 22 every time.
    expect(source).toContain("New-NetFirewallRule");
    expect(source).toContain("-LocalPort 22");
    expect(source).toMatch(/if \(-not \(Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'/);
  });

  test("discovers the capability rather than pinning its version", () => {
    // The name carries a version tail — OpenSSH.Server~~~~0.0.1.0 —
    // which is not the same string on every Windows build.
    expect(source).toContain("'OpenSSH.Server*'");
    expect(source).not.toContain("OpenSSH.Server~~~~0.0.1.0");
  });
});

describe("the administrator half is declared, not discovered", () => {
  /** Nobody at the machine, no rights held: the unelevated case. */
  const unelevated: BatchHost = {
    states: async () => ({}),
    elevated: async () => false,
    consentPossible: () => false,
    applyHere: async () => {
      throw new Error("an unelevated run did the privileged work anyway");
    },
    elevate: async () => {
      throw new Error("a consent prompt was raised with nobody to answer it");
    },
  };

  test("the module classifies no administrator refusal of its own", () => {
    // What this item used to do, and what named the gap: run PowerShell
    // unelevated, read the refusal back out of stderr, and hand the
    // operator its own instruction to open an elevated shell. A
    // requirement discovered by failing, once per item.
    //
    // The manifest declares it now, so anything reaching the Windows
    // half already holds the rights — a second classifier here would be
    // answering a question that was settled before the run started.
    expect(source).not.toMatch(/classifyRights\([^)]*"administrator"\)/);
    // The sudo half is untouched: apt is not the gate that moved, and
    // Ubuntu has no batch to join.
    expect(source).toContain('classifyRights(install.out, "sudo")');
  });

  test("and the Windows column says so before anything runs", () => {
    // Declared as data, which is what lets `plan` print the requirement
    // and the batch collect the item without either of them running it.
    expect(providerFor(sshServer, platform({ os: "windows", env: "windows" })).needsAdmin).toBe(
      true,
    );
  });

  test("its three steps are the ones the batch runs", async () => {
    // The capability, the service and the firewall rule, composed into
    // the shared script rather than spawned by this module. Borrowed
    // from the provider, so there is no second copy to keep true.
    const script = await batchScript([sshServer], "C:\\Temp\\red-dev-privileged.txt");
    expect(script).toContain("Add-WindowsCapability");
    expect(script).toContain("Set-Service -Name sshd -StartupType Automatic");
    expect(script).toContain("New-NetFirewallRule");
    expect(script).toContain("$report += 'ok ssh-server'");
  });

  test("an unelevated run defers it rather than failing it", async () => {
    // The outcome the item is owed: a machine that could not elevate is
    // one with work outstanding, not a broken one, and the operator gets
    // the shared remedy instead of a DISM stack trace.
    const [step] = await runPrivilegedBatch([sshServer], unelevated);
    expect(step?.tool.name).toBe("ssh-server");
    const outcome = outcomeForError(step?.error ?? "");
    expect(outcome.outcome).toBe("deferred");
    expect(outcome.remedy).toContain("elevated PowerShell");
  });
});

describe("the Linux half", () => {
  test("asks which unit name this distro uses", () => {
    // Debian and Ubuntu call it ssh; most others call it sshd, and
    // `systemctl enable ssh` on the latter fails as "unit not found",
    // which reads like a broken install.
    expect(source).toContain("list-unit-files");
    expect(source).toMatch(/\["ssh", "sshd"\]/);
  });

  test("does not claim to have started anything without systemd", () => {
    // The default for every WSL distro that has not opted in. The
    // package installs and nothing can run it, and that is worth
    // saying rather than reporting either failure or success.
    expect(source).toContain("p.caps.systemd");
    expect(source).toContain("wsl.conf");
  });
});
