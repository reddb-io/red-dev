/**
 * What the network Panel runs, and what it never runs.
 *
 * Three claims, and none of them is answerable by running anything. The
 * machine this test process is on has one network stack; the Panel has
 * to be right about two, and about a Windows host it will only ever meet
 * through WSL interop. So the argv is the artefact under test — pinned
 * word for word, per target, for the read and for each of the four DNS
 * choices — because argv is the whole of what reaches the machine and
 * the only part of it a test can hold.
 *
 * The other two claims are about privilege, and they are the reason this
 * file exists rather than a handful of cases in a parser test.
 *
 * Opening the Panel is never a privileged act. Not "does not usually
 * need sudo" — never, checkably, by reading the words of every command
 * observation builds. A viewer that raised a consent prompt to *show*
 * the DNS would teach people to dismiss consent prompts, and the next
 * one is the one that changes something.
 *
 * And a Panel act never lands in the converge's privileged batch
 * (decision of 2026-08-15). That one is pinned from the other side too:
 * the batch is composed for every target and read for the cmdlets and
 * binaries only this Panel drives, so an act that leaked into it would
 * fail here rather than take effect at the end of somebody's next
 * converge.
 */

import { describe, expect, test } from "bun:test";
import { ACTIONS } from "./actions/index.ts";
import { applicableScopes, type Scope } from "./manifest.ts";
import {
  DNS_CHOICES,
  applyDns,
  dnsPlan,
  joinedDevice,
  namedChoice,
  observeArgv,
  observeNetwork,
  observePlan,
  panelLines,
  PANEL_START,
  panelStep,
  panelTarget,
  parseDevices,
  parseResolvectlDns,
  parseWindowsView,
  raisesRights,
  readServers,
  serversFor,
  terseFields,
  type Captured,
  type DnsChoice,
  type NetworkView,
  type PanelKey,
  type PanelTarget,
} from "./panel-network.ts";
import { batchScript, privilegedItems, sectionNames } from "./privileged.ts";
import type { Platform } from "./platform.ts";

function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

const desktop = machine({});
const server = machine({
  env: "server",
  caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false },
});
const wsl = machine({ env: "wsl", caps: { apt: true, gui: false, systemd: false, winget: true, flatpak: false } });
const windows = machine({ os: "windows", env: "windows", distro: null, version: null, codename: null });
const mac = machine({ os: "darwin", env: "desktop", distro: null, version: null, codename: null });

/** A joined Ubuntu machine, as observation would have reported it. */
const onUbuntu: NetworkView = {
  target: "linux",
  network: "Wired connection 1",
  device: "enp3s0",
  handle: "Wired connection 1",
  state: "up",
  servers: ["192.168.1.1"],
  named: null,
};

/** A joined Windows machine. The handle is the interface index. */
const onWindows: NetworkView = {
  target: "windows",
  network: "Home",
  device: "Wi-Fi",
  handle: "12",
  state: "up",
  servers: ["192.168.1.1"],
  named: null,
};

const VIEWS: Record<PanelTarget, NetworkView> = { linux: onUbuntu, windows: onWindows };

/** No key pressed; each test turns on the one it means. */
function press(over: Partial<PanelKey> = {}): PanelKey {
  return {
    upArrow: false,
    downArrow: false,
    return: false,
    escape: false,
    backspace: false,
    delete: false,
    ctrl: false,
    ...over,
  };
}

describe("which CLI answers for a machine", () => {
  test("Ubuntu drives its own, desktop and server alike", () => {
    // Not one target per Env: a headless Ubuntu runs the same two
    // binaries a desktop does, and splitting them would be two copies of
    // one adapter.
    expect(panelTarget(desktop)).toBe("linux");
    expect(panelTarget(server)).toBe("linux");
  });

  test("WSL drives the Windows host's, because that is whose network it is", () => {
    // The distro sits behind a NAT and its resolv.conf is generated from
    // the host. Asking nmcli inside it would describe nothing.
    expect(panelTarget(wsl)).toBe("windows");
    expect(panelTarget(windows)).toBe("windows");
  });

  test("and a platform red-dev has no adapter for says so rather than guessing", () => {
    expect(panelTarget(mac)).toBeNull();
  });
});

describe("observation, pinned per target", () => {
  test("Ubuntu asks NetworkManager which network, and resolved what answers", () => {
    expect(observeArgv("linux")).toEqual([
      ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"],
      ["resolvectl", "dns"],
    ]);
  });

  test("Windows asks once, and gets all three answers back as JSON", () => {
    // One round trip rather than three: two adapters coming up between
    // calls yields a profile pointing at an interface the DNS list has
    // never heard of. Pinned whole, because the script is the argv.
    expect(observeArgv("windows")).toEqual([
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "$ErrorActionPreference = 'SilentlyContinue'; " +
          "$profiles = @(Get-NetConnectionProfile | ForEach-Object { [pscustomobject]@{" +
          " index = [int]$_.InterfaceIndex; name = [string]$_.Name;" +
          " alias = [string]$_.InterfaceAlias } }); " +
          "$adapters = @(Get-NetAdapter | ForEach-Object { [pscustomobject]@{" +
          " index = [int]$_.ifIndex; alias = [string]$_.Name;" +
          " status = [string]$_.Status } }); " +
          "$dns = @(Get-DnsClientServerAddress | ForEach-Object { [pscustomobject]@{" +
          " index = [int]$_.InterfaceIndex; servers = @($_.ServerAddresses) } }); " +
          "[pscustomobject]@{ profiles = $profiles; adapters = $adapters; dns = $dns } |" +
          " ConvertTo-Json -Depth 4 -Compress",
      ],
    ]);
  });

  test("reads both address families, so a change to both can be seen", () => {
    // No -AddressFamily filter. The Panel sets v4 and v6; a v4-only read
    // would show a machine as Cloudflare while a router answered over v6.
    const script = observeArgv("windows")[0]?.[3] ?? "";
    expect(script).not.toContain("-AddressFamily");
  });
});

describe("looking is never a privileged act", () => {
  for (const target of ["linux", "windows"] as const) {
    test(`on ${target}, no observation argv reaches for rights`, () => {
      const plan = observePlan(target);
      // Both halves. `gate` is the claim the code makes about itself and
      // `raisesRights` reads the words that actually run, so a plan
      // cannot say null while quietly carrying a sudo.
      expect(plan.gate).toBeNull();
      expect(plan.prime).toBeNull();
      for (const step of plan.steps) expect(raisesRights(step)).toBe(false);
    });

    test(`on ${target}, every observation command is a read`, () => {
      // Named rather than implied by raisesRights: a cmdlet that writes
      // without elevating is still not something opening a Panel does.
      for (const step of observePlan(target).steps) {
        const words = step.join(" ");
        expect(words).not.toContain("Set-");
        expect(words).not.toContain("sudo");
        expect(words).not.toContain("RunAs");
        expect(words).not.toContain("nmcli connection modify");
      }
    });
  }

  test("and the argv reader recognises both gates, in both spellings", () => {
    // The check is only worth having if it fires; a reader that returned
    // false for everything would pass every test above.
    expect(raisesRights(["sudo", "-n", "nmcli"])).toBe(true);
    expect(raisesRights(["pkexec", "nmcli"])).toBe(true);
    expect(raisesRights(["powershell.exe", "-Command", "Start-Process x -Verb RunAs"])).toBe(true);
    expect(raisesRights(["nmcli", "-t", "device", "status"])).toBe(false);
  });
});

describe("each DNS choice, pinned per target", () => {
  test("Ubuntu records the choice on the connection, then brings it up", () => {
    const plan = dnsPlan(onUbuntu, "cloudflare");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.prime).toEqual(["sudo", "-v"]);
    expect(plan.steps).toEqual([
      [
        "sudo", "-n", "nmcli", "connection", "modify", "Wired connection 1",
        "ipv4.ignore-auto-dns", "yes", "ipv4.dns", "1.1.1.1 1.0.0.1",
        "ipv6.ignore-auto-dns", "yes", "ipv6.dns",
        "2606:4700:4700::1111 2606:4700:4700::1001",
      ],
      ["sudo", "-n", "nmcli", "connection", "up", "Wired connection 1"],
    ]);
    expect(plan.gate).toBe("sudo");
  });

  test("Ubuntu's Google entry is the same act with the other addresses", () => {
    const plan = dnsPlan(onUbuntu, "google");
    expect(plan.ok && plan.steps[0]).toEqual([
      "sudo", "-n", "nmcli", "connection", "modify", "Wired connection 1",
      "ipv4.ignore-auto-dns", "yes", "ipv4.dns", "8.8.8.8 8.8.4.4",
      "ipv6.ignore-auto-dns", "yes", "ipv6.dns",
      "2001:4860:4860::8888 2001:4860:4860::8844",
    ]);
  });

  test("Ubuntu's DHCP entry hands the question back rather than clearing a list", () => {
    // ignore-auto-dns back to `no` is what DHCP means as an act. Setting
    // only ipv4.dns to "" would leave the flag on and the machine with
    // no resolver at all.
    const plan = dnsPlan(onUbuntu, "dhcp");
    expect(plan.ok && plan.steps[0]).toEqual([
      "sudo", "-n", "nmcli", "connection", "modify", "Wired connection 1",
      "ipv4.ignore-auto-dns", "no", "ipv4.dns", "",
      "ipv6.ignore-auto-dns", "no", "ipv6.dns", "",
    ]);
  });

  test("Ubuntu's custom entry carries what was typed, family by family", () => {
    // One family given, so only that family stops following the network
    // — which is what the Windows cmdlet does, and the reason the flag
    // is decided per family rather than per choice.
    const plan = dnsPlan(onUbuntu, "custom", "9.9.9.9, 149.112.112.112");
    expect(plan.ok && plan.steps[0]).toEqual([
      "sudo", "-n", "nmcli", "connection", "modify", "Wired connection 1",
      "ipv4.ignore-auto-dns", "yes", "ipv4.dns", "9.9.9.9 149.112.112.112",
      "ipv6.ignore-auto-dns", "no", "ipv6.dns", "",
    ]);
  });

  test("Windows raises consent and does the work behind it, in one act", () => {
    // There is no prime: UAC cannot be raised early and held, so the
    // dialog belongs to the act itself.
    const plan = dnsPlan(onWindows, "cloudflare");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.prime).toBeNull();
    expect(plan.steps).toEqual([
      [
        "powershell.exe",
        "-NoProfile",
        "-Command",
        "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden " +
          "-ArgumentList '-NoProfile','-Command'," +
          "'Set-DnsClientServerAddress -InterfaceIndex 12 -ServerAddresses " +
          "''1.1.1.1'',''1.0.0.1'',''2606:4700:4700::1111'',''2606:4700:4700::1001''" +
          "; Clear-DnsClientCache'",
      ],
    ]);
    expect(plan.gate).toBe("administrator");
  });

  test("Windows' Google entry differs only in the addresses", () => {
    expect(dnsPlan(onWindows, "google").ok && dnsPlan(onWindows, "google")).toMatchObject({
      steps: [
        [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden " +
            "-ArgumentList '-NoProfile','-Command'," +
            "'Set-DnsClientServerAddress -InterfaceIndex 12 -ServerAddresses " +
            "''8.8.8.8'',''8.8.4.4'',''2001:4860:4860::8888'',''2001:4860:4860::8844''" +
            "; Clear-DnsClientCache'",
        ],
      ],
    });
  });

  test("Windows' DHCP entry resets the list rather than emptying it", () => {
    expect(dnsPlan(onWindows, "dhcp").ok && dnsPlan(onWindows, "dhcp")).toMatchObject({
      steps: [
        [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden " +
            "-ArgumentList '-NoProfile','-Command'," +
            "'Set-DnsClientServerAddress -InterfaceIndex 12 -ResetServerAddresses" +
            "; Clear-DnsClientCache'",
        ],
      ],
    });
  });

  test("Windows' custom entry has its quotes doubled inside the elevated command", () => {
    // The addresses ride inside a single-quoted PowerShell string, so
    // every quote around them has to be doubled — the same escape the
    // privileged batch makes for its result path.
    const plan = dnsPlan(onWindows, "custom", "9.9.9.9");
    expect(plan.ok && plan.steps[0]?.[3]).toContain("-ServerAddresses ''9.9.9.9''");
  });

  test("every choice, on every target, passes a gate and names it", () => {
    // The complement of the observation rule: changing DNS is privileged
    // everywhere, so a plan that came back with no gate would be one
    // that had quietly stopped asking.
    for (const target of ["linux", "windows"] as const) {
      for (const choice of DNS_CHOICES) {
        const plan = dnsPlan(VIEWS[target], choice, "9.9.9.9");
        expect(plan.ok).toBe(true);
        if (!plan.ok) continue;
        expect(plan.gate).toBe(target === "linux" ? "sudo" : "administrator");
        expect(plan.steps.some((step) => raisesRights(step)) || plan.prime !== null).toBe(true);
      }
    }
  });
});

describe("a change the Panel cannot make", () => {
  test("with nothing joined, is refused rather than aimed at a guess", () => {
    const plan = dnsPlan({ ...onUbuntu, handle: null }, "cloudflare");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toContain("no joined network");
  });

  test("on a platform with no adapter, is refused by name", () => {
    const plan = dnsPlan({ ...onUbuntu, target: null }, "google");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toContain("no network adapter");
  });

  test("with an empty custom field, asks for an address instead of running", () => {
    const plan = dnsPlan(onUbuntu, "custom", "   ");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toContain("type one or more resolver addresses");
  });

  test("with a typo in the custom field, names the word that is not an address", () => {
    const plan = dnsPlan(onUbuntu, "custom", "1.1.1.1 wat");
    expect(plan.ok).toBe(false);
    expect(plan.ok || plan.detail).toBe("not an address: wat");
  });

  test("and an octet over 255 is a typo too", () => {
    expect(serversFor("custom", "999.1.1.1")).toBeNull();
    expect(serversFor("custom", "1.1.1.1")).toEqual(["1.1.1.1"]);
    expect(serversFor("custom", "2606:4700:4700::1111")).toEqual(["2606:4700:4700::1111"]);
  });

  test("addresses may be separated by commas or spaces, because both are how people write them", () => {
    expect(readServers("1.1.1.1, 1.0.0.1")).toEqual(["1.1.1.1", "1.0.0.1"]);
    expect(readServers(" 1.1.1.1   1.0.0.1 ")).toEqual(["1.1.1.1", "1.0.0.1"]);
  });
});

describe("no Panel act reaches the converge's privileged batch", () => {
  // The decision this pins: "make this machine correct" and "change this
  // now" are different things. The batch is the first; the Panel is the
  // second, and an act of its that ended up in the batch would take
  // effect at the end of somebody's next converge instead of when they
  // asked for it.
  const targets: Platform[] = [desktop, server, wsl, windows];
  const scopes: Scope[][] = [["core"], ["core", "desktop"], ["core", "wsl"], ["core", "optional"]];

  test("the batch names no item the Panel drives", async () => {
    for (const p of targets) {
      for (const scope of scopes) {
        const items = privilegedItems(p, scope);
        for (const item of items) {
          expect(item.name).not.toContain("panel");
          expect(item.name).not.toContain("dns");
        }
      }
    }
  });

  test("and the composed batch script carries none of the Panel's commands", async () => {
    // Read from the other side, because a name is easy to keep clean and
    // a script is where an act would actually be smuggled in.
    for (const p of targets) {
      const script = await batchScript(privilegedItems(p, applicableScopes(p)), "C:\\tmp\\r.txt");
      expect(script).not.toContain("Set-DnsClientServerAddress");
      expect(script).not.toContain("Clear-DnsClientCache");
      expect(script).not.toContain("nmcli");
      expect(script).not.toContain("resolvectl");
    }
  });

  test("and this build composes a batch section for nothing of the Panel's", () => {
    for (const name of sectionNames()) expect(name).not.toContain("panel");
  });

  test("while the action that opens the Panel is not privileged either", () => {
    // Opening is looking. `privileged` on a registry entry describes
    // opening, not everything the Panel can go on to do — which is what
    // the Panels module's own header says, made checkable.
    for (const action of ACTIONS.filter((a) => a.id.startsWith("panel."))) {
      expect(action.privileged).toBe(false);
      expect(action.mutates).toBe(false);
    }
  });
});

describe("reading what Ubuntu said", () => {
  const STATUS = [
    "lo:loopback:unmanaged:",
    "enp3s0:ethernet:connected:Wired connection 1",
    "wlp2s0:wifi:disconnected:",
  ].join("\n");

  test("splits nmcli's terse output on the separator it escapes", () => {
    // A connection called "Home: 5GHz" arrives as `Home\: 5GHz`, and a
    // plain split(":") walks straight past it — into the field every
    // change command takes back to nmcli.
    expect(terseFields("wlp2s0:wifi:connected:Home\\: 5GHz")).toEqual([
      "wlp2s0",
      "wifi",
      "connected",
      "Home: 5GHz",
    ]);
  });

  test("takes the connected physical device as the network that is joined", () => {
    expect(joinedDevice(parseDevices(STATUS))?.device).toBe("enp3s0");
  });

  test("never takes loopback, even when nothing else is connected", () => {
    const down = parseDevices(["lo:loopback:unmanaged:", "enp3s0:ethernet:disconnected:"].join("\n"));
    // A real adapter that is down is the answer, so the Panel can say
    // "down" about the machine rather than saying nothing.
    expect(joinedDevice(down)?.device).toBe("enp3s0");
  });

  test("reads resolvectl per link, and leaves the global block out of it", () => {
    const out = [
      "Global: 9.9.9.9",
      "Link 2 (enp3s0): 1.1.1.1 1.0.0.1",
      "Link 3 (wlp2s0):",
    ].join("\n");
    expect(parseResolvectlDns(out)).toEqual({
      enp3s0: ["1.1.1.1", "1.0.0.1"],
      wlp2s0: [],
    });
  });

  test("and puts the two answers together into one view", async () => {
    const capture = async (cmd: readonly string[]): Promise<Captured> =>
      cmd[0] === "nmcli"
        ? { out: STATUS, code: 0 }
        : { out: "Link 2 (enp3s0): 1.1.1.1 1.0.0.1", code: 0 };

    expect(await observeNetwork(desktop, capture)).toEqual({
      target: "linux",
      network: "Wired connection 1",
      device: "enp3s0",
      handle: "Wired connection 1",
      state: "up",
      servers: ["1.1.1.1", "1.0.0.1"],
      named: "cloudflare",
    });
  });

  test("a machine with no NetworkManager reports nothing rather than inventing a name", async () => {
    const capture = async (): Promise<Captured> => ({ out: "", code: 127 });
    const view = await observeNetwork(desktop, capture);
    expect(view).toMatchObject({ target: "linux", network: null, state: "unknown" });
  });
});

describe("reading what Windows said", () => {
  const JSON_OUT = JSON.stringify({
    profiles: [{ index: 12, name: "Home", alias: "Wi-Fi" }],
    adapters: [
      { index: 12, alias: "Wi-Fi", status: "Up" },
      { index: 3, alias: "Ethernet", status: "Disconnected" },
    ],
    dns: [
      { index: 12, servers: ["8.8.8.8", "8.8.4.4"] },
      { index: 12, servers: ["2001:4860:4860::8888"] },
      { index: 3, servers: ["192.168.1.1"] },
    ],
  });

  test("anchors on the joined profile and keeps the index as the handle", () => {
    // The index, not the alias: it is what Set-DnsClientServerAddress
    // takes, and it survives an adapter being renamed mid-session.
    expect(parseWindowsView(JSON_OUT)).toEqual({
      target: "windows",
      network: "Home",
      device: "Wi-Fi",
      handle: "12",
      state: "up",
      servers: ["8.8.8.8", "8.8.4.4", "2001:4860:4860::8888"],
      named: "google",
    });
  });

  test("PowerShell writing an error where the JSON belonged is not a machine to guess about", () => {
    expect(parseWindowsView("Get-NetAdapter : not recognized")).toMatchObject({
      target: "windows",
      network: null,
      handle: null,
    });
  });

  test("a single profile serialised as a bare object is still a profile", () => {
    // ConvertTo-Json unwraps one-element lists often enough that the
    // neighbouring probe in lan-address.ts handles it too.
    const bare = JSON.stringify({
      profiles: { index: 5, name: "Cafe", alias: "Wi-Fi" },
      adapters: { index: 5, alias: "Wi-Fi", status: "Up" },
      dns: { index: 5, servers: "1.1.1.1" },
    });
    expect(parseWindowsView(bare)).toMatchObject({ network: "Cafe", handle: "5", servers: ["1.1.1.1"] });
  });
});

describe("which choice the machine is on", () => {
  test("recognises a named resolver by its addresses, in any order", () => {
    expect(namedChoice(["1.0.0.1", "1.1.1.1"])).toBe("cloudflare");
    expect(namedChoice(["8.8.8.8"])).toBe("google");
  });

  test("says nothing about a router's address, because it cannot tell DHCP from a pin", () => {
    // Neither CLI's read says whether an address was handed out or typed
    // in. Guessing "DHCP" would be wrong on every machine that pinned it.
    expect(namedChoice(["192.168.1.1"])).toBeNull();
    expect(namedChoice([])).toBeNull();
    expect(namedChoice(["1.1.1.1", "192.168.1.1"])).toBeNull();
  });
});

describe("the Panel as text, for a terminal with none to draw", () => {
  test("carries the three facts the drawn one leads with", () => {
    expect(panelLines({ ...onUbuntu, servers: ["1.1.1.1"], named: "cloudflare" })).toEqual([
      "network  Wired connection 1",
      "link     enp3s0 — up",
      "dns      1.1.1.1 (Cloudflare)",
    ]);
  });

  test("and says what it does not know, rather than leaving a blank", () => {
    expect(panelLines({ ...onUbuntu, network: null, device: null, state: "unknown", servers: [], named: null }))
      .toEqual([
        "network  not joined",
        "link     none — unknown",
        "dns      none reported",
      ]);
  });
});

describe("the keyboard", () => {
  test("the arrows move between the four choices and stop at the ends", () => {
    let state = panelStep(PANEL_START, "", press({ upArrow: true })).state;
    expect(state.index).toBe(0);
    for (let i = 0; i < 9; i++) state = panelStep(state, "", press({ downArrow: true })).state;
    expect(state.index).toBe(DNS_CHOICES.length - 1);
  });

  test("enter asks for the highlighted choice", () => {
    const step = panelStep({ index: 1, custom: "" }, "", press({ return: true }));
    expect(step.apply).toBe("cloudflare" satisfies DnsChoice);
  });

  test("typing fills the custom field only while the custom row is highlighted", () => {
    // A stray letter that silently filled a field three rows down would
    // be a change nobody asked for.
    expect(panelStep({ index: 0, custom: "" }, "9", press()).state.custom).toBe("");
    expect(panelStep({ index: 3, custom: "" }, "9", press()).state.custom).toBe("9");
  });

  test("escape clears what was typed before it closes the Panel", () => {
    const cleared = panelStep({ index: 3, custom: "9.9.9.9" }, "", press({ escape: true }));
    expect(cleared.quit).toBeUndefined();
    expect(cleared.state.custom).toBe("");
    expect(panelStep({ index: 3, custom: "" }, "", press({ escape: true })).quit).toBe(true);
  });

  test("ctrl+c leaves, and every other ctrl chord is swallowed", () => {
    expect(panelStep(PANEL_START, "c", press({ ctrl: true })).quit).toBe(true);
    expect(panelStep({ index: 3, custom: "" }, "a", press({ ctrl: true })).state.custom).toBe("");
  });
});

describe("carrying a plan out", () => {
  test("asks once, then runs the acts in order", async () => {
    const ran: string[][] = [];
    const outcome = await applyDns(dnsPlan(onUbuntu, "cloudflare"), async (argv) => {
      ran.push([...argv]);
      return 0;
    });
    expect(ran[0]).toEqual(["sudo", "-v"]);
    expect(ran).toHaveLength(3);
    expect(outcome).toEqual({ changed: true, detail: "dns: Cloudflare on Wired connection 1" });
  });

  test("a refused password stops before anything is written", async () => {
    const ran: string[][] = [];
    const outcome = await applyDns(dnsPlan(onUbuntu, "google"), async (argv) => {
      ran.push([...argv]);
      return argv[1] === "-v" ? 1 : 0;
    });
    expect(ran).toEqual([["sudo", "-v"]]);
    expect(outcome.changed).toBe(false);
    expect(outcome.detail).toContain("sudo needs a password");
  });

  test("a first act that failed does not get followed by the one that applies it", async () => {
    // `connection up` after a failed `modify` would bring the connection
    // up with the DNS it already had, and report that as the change.
    const ran: string[][] = [];
    const outcome = await applyDns(dnsPlan(onUbuntu, "dhcp"), async (argv) => {
      ran.push([...argv]);
      return argv.includes("modify") ? 2 : 0;
    });
    expect(ran.map((a) => a.join(" ")).some((a) => a.includes("connection up"))).toBe(false);
    expect(outcome.changed).toBe(false);
  });

  test("a declined UAC dialog comes back as the administrator remedy", async () => {
    const outcome = await applyDns(dnsPlan(onWindows, "cloudflare"), async () => 1);
    expect(outcome.changed).toBe(false);
    expect(outcome.detail).toContain("this needs administrator");
  });

  test("a refusal runs nothing at all", async () => {
    let calls = 0;
    const outcome = await applyDns(dnsPlan(onUbuntu, "custom", ""), async () => {
      calls++;
      return 0;
    });
    expect(calls).toBe(0);
    expect(outcome.changed).toBe(false);
  });
});
