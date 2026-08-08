import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import type { Platform } from "./platform.ts";
import { writePreferences } from "./preferences.ts";
import {
  addressFor,
  addressFromRoutes,
  parseLinuxAddresses,
  parseLinuxDefaultRoutes,
  parseWindowsNetState,
  resolveLanAddress,
  resolveRedwallAddress,
  routableInterfaces,
} from "./lan-address.ts";

/**
 * The measured machine from the Redwall spec: three IPv4 addresses, of
 * which exactly one is reachable from another host. Index order is the
 * trap — the LAN adapter is neither first nor last.
 */
const WINDOWS_MEASURED = JSON.stringify({
  routes: [{ index: 12, metric: 0, interfaceMetric: 25 }],
  addresses: [
    { index: 1, name: "Loopback Pseudo-Interface 1", address: "127.0.0.1" },
    { index: 58, name: "vEthernet (WSL)", address: "172.28.16.1" },
    { index: 12, name: "Ethernet", address: "192.168.1.42" },
    { index: 21, name: "Ethernet 2", address: "169.254.83.11" },
  ],
});

/** The same machine after the cable came out and Wi-Fi took the route. */
const WINDOWS_ROAMED = JSON.stringify({
  routes: [{ index: 15, metric: 0, interfaceMetric: 35 }],
  addresses: [
    { index: 1, name: "Loopback Pseudo-Interface 1", address: "127.0.0.1" },
    { index: 58, name: "vEthernet (WSL)", address: "172.28.16.1" },
    { index: 12, name: "Ethernet", address: "169.254.9.4" },
    { index: 15, name: "Wi-Fi", address: "192.168.4.77" },
  ],
});

/** Airplane mode: adapters and addresses still there, nothing routes. */
const WINDOWS_OFFLINE = JSON.stringify({
  routes: [],
  addresses: [
    { index: 1, name: "Loopback Pseudo-Interface 1", address: "127.0.0.1" },
    { index: 58, name: "vEthernet (WSL)", address: "172.28.16.1" },
    { index: 12, name: "Ethernet", address: "169.254.83.11" },
  ],
});

const LINUX_ROUTES = [
  "default via 192.168.1.1 dev enp3s0 proto dhcp src 192.168.1.42 metric 100",
  "default via 10.42.0.1 dev wlp2s0 proto dhcp src 10.42.0.19 metric 600",
].join("\n");

const LINUX_ADDRESSES = [
  "1: lo    inet 127.0.0.1/8 scope host lo\\       valid_lft forever preferred_lft forever",
  "2: enp3s0    inet 192.168.1.42/24 brd 192.168.1.255 scope global dynamic noprefixroute enp3s0\\       valid_lft 84559sec preferred_lft 84559sec",
  "3: wlp2s0    inet 10.42.0.19/24 brd 10.42.0.255 scope global dynamic noprefixroute wlp2s0\\       valid_lft 3421sec preferred_lft 3421sec",
  "4: docker0    inet 172.17.0.1/16 brd 172.17.255.255 scope global docker0\\       valid_lft forever preferred_lft forever",
].join("\n");

function platform(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
    ...over,
  };
}

/** A capture seam that answers by command and records what was asked. */
function fakeCapture(answers: Array<[RegExp, { out: string; code?: number }]>) {
  const asked: string[] = [];
  const capture = async (cmd: string[]) => {
    const line = cmd.join(" ");
    asked.push(line);
    for (const [pattern, answer] of answers) {
      if (pattern.test(line)) return { out: answer.out, code: answer.code ?? 0 };
    }
    return { out: "", code: 127 };
  };
  return { capture, asked };
}

describe("the default route picks the address", () => {
  test("a LAN adapter beats a virtual switch and a disconnected APIPA address", () => {
    const state = parseWindowsNetState(WINDOWS_MEASURED);
    expect(addressFromRoutes(state.routes, state.addresses)).toBe("192.168.1.42");
  });

  test("no default route resolves to nothing rather than to a present address", () => {
    const state = parseWindowsNetState(WINDOWS_OFFLINE);
    expect(state.addresses.length).toBe(3);
    expect(addressFromRoutes(state.routes, state.addresses)).toBeNull();
  });

  test("the answer follows the route when it moves to another adapter", () => {
    const state = parseWindowsNetState(WINDOWS_ROAMED);
    expect(addressFromRoutes(state.routes, state.addresses)).toBe("192.168.4.77");
  });

  test("two default routes are decided by metric, not by order", () => {
    const routes = [
      { interfaceName: null, interfaceIndex: 15, metric: 55, source: null },
      { interfaceName: null, interfaceIndex: 12, metric: 25, source: null },
    ];
    const addresses = [
      { interfaceName: "Wi-Fi", interfaceIndex: 15, address: "192.168.4.77" },
      { interfaceName: "Ethernet", interfaceIndex: 12, address: "192.168.1.42" },
    ];
    expect(addressFromRoutes(routes, addresses)).toBe("192.168.1.42");
  });

  test("a route whose interface carries no usable address falls to the next one", () => {
    const routes = [
      { interfaceName: null, interfaceIndex: 21, metric: 5, source: null },
      { interfaceName: null, interfaceIndex: 12, metric: 25, source: null },
    ];
    const addresses = [
      { interfaceName: "Ethernet 2", interfaceIndex: 21, address: "169.254.83.11" },
      { interfaceName: "Ethernet", interfaceIndex: 12, address: "192.168.1.42" },
    ];
    expect(addressFromRoutes(routes, addresses)).toBe("192.168.1.42");
  });

  test("an interface with a route but no address at all invents nothing", () => {
    const routes = [{ interfaceName: "tun0", interfaceIndex: null, metric: 0, source: null }];
    expect(addressFromRoutes(routes, [])).toBeNull();
  });
});

describe("reading what Windows reports", () => {
  test("a single route is still a list when PowerShell unrolls it", () => {
    const unrolled = JSON.stringify({
      routes: { index: 12, metric: 0, interfaceMetric: 25 },
      addresses: { index: 12, name: "Ethernet", address: "192.168.1.42" },
    });
    const state = parseWindowsNetState(unrolled);
    expect(state.routes).toEqual([
      { interfaceName: null, interfaceIndex: 12, metric: 25, source: null },
    ]);
    expect(addressFromRoutes(state.routes, state.addresses)).toBe("192.168.1.42");
  });

  test("output that is not JSON is no answer rather than a crash", () => {
    expect(parseWindowsNetState("Get-NetRoute : the term is not recognized")).toEqual({
      routes: [],
      addresses: [],
    });
  });
});

describe("reading what Linux reports", () => {
  test("the kernel's own source address is taken from the winning route", () => {
    const routes = parseLinuxDefaultRoutes(LINUX_ROUTES);
    expect(routes.length).toBe(2);
    expect(addressFromRoutes(routes, parseLinuxAddresses(LINUX_ADDRESSES))).toBe("192.168.1.42");
  });

  test("a route without a source address is matched to its interface", () => {
    const routes = parseLinuxDefaultRoutes("default via 10.42.0.1 dev wlp2s0 proto dhcp metric 600");
    expect(routes[0]?.source).toBeNull();
    expect(addressFromRoutes(routes, parseLinuxAddresses(LINUX_ADDRESSES))).toBe("10.42.0.19");
  });

  test("non-default routes are not addresses this machine answers on", () => {
    expect(parseLinuxDefaultRoutes("172.17.0.0/16 dev docker0 proto kernel src 172.17.0.1")).toEqual(
      [],
    );
  });
});

/**
 * A pin is an override, so every test here is written as a comparison
 * with what the default route would have said. A pin that happens to
 * agree with the route proves nothing about either.
 */
describe("pinning an interface", () => {
  const linuxState = {
    routes: parseLinuxDefaultRoutes(LINUX_ROUTES),
    addresses: parseLinuxAddresses(LINUX_ADDRESSES),
  };
  const roamed = parseWindowsNetState(WINDOWS_ROAMED);

  test("nothing pinned leaves the default route in charge", () => {
    expect(addressFor(linuxState, null)).toBe("192.168.1.42");
    expect(addressFor(roamed, null)).toBe("192.168.4.77");
  });

  test("a pinned interface is reported even though the route points elsewhere", () => {
    // The route leaves by enp3s0; this machine is reached on the Wi-Fi.
    expect(addressFor(linuxState, "wlp2s0")).toBe("10.42.0.19");
    // And the Windows shape of the same case: the LAN answers on Wi-Fi,
    // the person wants the address the VM network can see.
    expect(addressFor(roamed, "vEthernet (WSL)")).toBe("172.28.16.1");
  });

  test("a pin naming an interface that is gone falls back to the default route", () => {
    // The VPN was up when the pin was made and is not up now.
    expect(addressFor(linuxState, "tun0")).toBe("192.168.1.42");
    expect(addressFor(roamed, "Ethernet 9")).toBe("192.168.4.77");
  });

  test("a pin naming an interface with no usable address falls back too", () => {
    // Present, and holding nothing another machine could reach:
    // loopback never leaves the host, and the unplugged adapter's APIPA
    // address means DHCP found nobody.
    expect(addressFor(linuxState, "lo")).toBe("192.168.1.42");
    expect(addressFor(roamed, "Ethernet")).toBe("192.168.4.77");
  });

  test("the name is matched the way a person would have typed it", () => {
    // "vEthernet (WSL)" is an adapter alias read off a screen, and the
    // case it is read in is not the pin's meaning.
    expect(addressFor(roamed, "  VETHERNET (WSL)  ")).toBe("172.28.16.1");
  });

  test("an empty pin is not a pin", () => {
    expect(addressFor(linuxState, "")).toBe("192.168.1.42");
    expect(addressFor(linuxState, "   ")).toBe("192.168.1.42");
  });

  test("a pin invents no answer on a machine that has none", () => {
    // Falling back to the default route is falling back to nothing here,
    // and nothing is the honest answer — an unreachable address looks
    // exactly like one that works.
    const offline = parseWindowsNetState(WINDOWS_OFFLINE);
    expect(addressFor(offline, "Ethernet")).toBeNull();
    expect(addressFor(offline, "Wi-Fi")).toBeNull();
  });
});

describe("the interfaces worth offering as a pin", () => {
  test("are the ones holding an address another machine could reach", () => {
    // Loopback and the disconnected adapter are left out: pinning them
    // is pinning the fallback, which is a menu entry that does nothing.
    expect(routableInterfaces(parseWindowsNetState(WINDOWS_MEASURED))).toEqual([
      { name: "vEthernet (WSL)", address: "172.28.16.1" },
      { name: "Ethernet", address: "192.168.1.42" },
    ]);
  });

  test("are listed once each, however many addresses they hold", () => {
    const twice = {
      routes: [],
      addresses: [
        { interfaceName: "eth0", interfaceIndex: 2, address: "192.168.1.42" },
        { interfaceName: "eth0", interfaceIndex: 2, address: "10.0.0.5" },
      ],
    };
    expect(routableInterfaces(twice)).toEqual([{ name: "eth0", address: "192.168.1.42" }]);
  });
});

describe("resolving on a real machine", () => {
  test("a Linux desktop asks the local route table", async () => {
    const { capture, asked } = fakeCapture([
      [/^ip -4 route show default$/, { out: LINUX_ROUTES }],
      [/^ip -o -4 addr show$/, { out: LINUX_ADDRESSES }],
    ]);
    expect(await resolveLanAddress(platform({ env: "desktop" }), capture)).toBe("192.168.1.42");
    expect(asked.some((cmd) => cmd.startsWith("powershell.exe"))).toBe(false);
  });

  test("WSL answers with the Windows host's address, not the distro's", async () => {
    const { capture, asked } = fakeCapture([
      [/^powershell\.exe /, { out: WINDOWS_MEASURED }],
      // Present so the test fails loudly if the distro is asked instead:
      // eth0 behind the NAT is exactly the wrong answer.
      [/^ip /, { out: "default via 172.28.16.1 dev eth0 src 172.28.30.7 metric 100" }],
    ]);
    expect(await resolveLanAddress(platform({ env: "wsl" }), capture)).toBe("192.168.1.42");
    expect(asked.every((cmd) => cmd.startsWith("powershell.exe"))).toBe(true);
  });

  test("native Windows asks the same question of the same host", async () => {
    const { capture } = fakeCapture([[/^powershell\.exe /, { out: WINDOWS_ROAMED }]]);
    const windows = platform({ os: "windows", env: "windows", distro: null, version: null });
    expect(await resolveLanAddress(windows, capture)).toBe("192.168.4.77");
  });

  test("a command that cannot run reports nothing", async () => {
    const { capture } = fakeCapture([]);
    expect(await resolveLanAddress(platform({ env: "desktop" }), capture)).toBeNull();
  });

  test("darwin fails closed, as it does everywhere else", async () => {
    const { capture, asked } = fakeCapture([[/./, { out: LINUX_ROUTES }]]);
    expect(await resolveLanAddress(platform({ os: "darwin" }), capture)).toBeNull();
    expect(asked).toEqual([]);
  });
});

/**
 * `addressFor` proves the rule; these prove the stored preference is the
 * thing the rule is given. A pin nothing reads is a setting that lies,
 * and it lies in the direction of "I already told you which interface".
 */
describe("the address Redwall reports", () => {
  const desktop = platform({ env: "desktop" });

  /** A machine with no preferences, torn down with the process. */
  async function onFreshMachine<T>(run: () => Promise<T>): Promise<T> {
    const previous = process.env["HOME"];
    const home = mkdtempSync(`${tmpdir()}/red-dev-pin-`);
    mkdirSync(`${home}/.config/alacritty`, { recursive: true });
    process.env["HOME"] = home;
    try {
      return await run();
    } finally {
      if (previous === undefined) delete process.env["HOME"];
      else process.env["HOME"] = previous;
    }
  }

  const machine = () =>
    fakeCapture([
      [/^ip -4 route show default$/, { out: LINUX_ROUTES }],
      [/^ip -o -4 addr show$/, { out: LINUX_ADDRESSES }],
    ]).capture;

  test("is the default route's when nothing is pinned", async () => {
    await onFreshMachine(async () => {
      expect(await resolveRedwallAddress(desktop, machine())).toBe("192.168.1.42");
    });
  });

  test("is the pinned interface's when one is set", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwallInterface: "wlp2s0" });
      expect(await resolveRedwallAddress(desktop, machine())).toBe("10.42.0.19");
    });
  });

  test("is the default route's again once the pinned interface is gone", async () => {
    await onFreshMachine(async () => {
      await writePreferences(desktop, { redwallInterface: "tun0" });
      expect(await resolveRedwallAddress(desktop, machine())).toBe("192.168.1.42");
    });
  });
});
