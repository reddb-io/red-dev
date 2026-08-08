/**
 * The address this machine answers on.
 *
 * Not "an IPv4 address the machine has" — a laptop routinely has three
 * or four of those and only one of them reaches it from across the
 * room. The measured case that motivated this: a Windows host reporting
 * the LAN address on an `Up` Ethernet adapter, the WSL virtual switch,
 * and a disconnected adapter's APIPA address. Picking by index, by
 * adapter name, or by "the first one that is not loopback" picks wrong
 * on that machine, and would keep picking wrong in a different way once
 * a VPN or a container bridge appears.
 *
 * So the rule is the routing table's own answer: whichever interface
 * carries the default route owns the address, because that is the
 * interface packets to the rest of the world actually leave by. It
 * needs no list of virtual adapters to ignore, it follows a laptop from
 * Ethernet to Wi-Fi without being told, and when there is no default
 * route it says so instead of guessing — an address nobody can reach is
 * worse than no address, because it looks like one that works.
 *
 * ## The WSL twist
 *
 * Under WSL the answer is the *Windows host's* address. The distro sits
 * behind a NAT: its `eth0` address is real, routable inside the host,
 * and reaches nothing from another machine — the same reason
 * `ssh-server.ts` configures sshd on the Windows side. So WSL asks
 * PowerShell rather than `ip`, which is only a difference in who is
 * asked. The rule applied to the answer is identical, which is why both
 * mechanisms parse into one shape and one `addressFromRoutes` decides.
 *
 * Darwin is deliberately absent, failing closed as it does in
 * `providerFor` and per .red/adr/0001.
 *
 * ## When the route is not the answer
 *
 * The route is right about how packets leave and can still be wrong
 * about how a person reaches this machine: a VPN carrying the default
 * route while the laptop is wanted on the office LAN, a second NIC on
 * the network everyone else is on. So an interface can be pinned, and a
 * pin wins over the route.
 *
 * It wins only while it can. An interface that has gone away, or that
 * holds nothing reachable, falls back to the default route rather than
 * to nothing — a pin is a preference about which of several right
 * answers to show, and it should not be able to turn into a wrong one
 * because a VPN dropped. That is why the fallback is the rule above and
 * not an error.
 */

import type { Platform } from "./platform.ts";
import { resolveRedwallInterface } from "./preferences.ts";
import { readWindowsOutput } from "./windows-output.ts";

/** A default route, as either platform describes one. */
export interface DefaultRoute {
  /** How Linux names the interface; null when only an index was given. */
  interfaceName: string | null;
  /** How Windows names it; null when only a name was given. */
  interfaceIndex: number | null;
  /** Lower wins. Windows sums the route and interface metrics. */
  metric: number;
  /**
   * The address the kernel itself would send from over this route.
   * Linux offers it directly; Windows does not, and leaves it null.
   */
  source: string | null;
}

/** An IPv4 address the machine holds, and where it holds it. */
export interface HostAddress {
  interfaceName: string | null;
  interfaceIndex: number | null;
  address: string;
}

export interface NetState {
  routes: DefaultRoute[];
  addresses: HostAddress[];
}

/** Ran, and what it printed. */
export interface Captured {
  out: string;
  code: number;
}

/** The seam the tests replace: how a question reaches the machine. */
export type Capture = (cmd: string[]) => Promise<Captured>;

const NOTHING: NetState = { routes: [], addresses: [] };

// ------------------------------------------------------------- the rule

/**
 * An address that can be reached from another machine.
 *
 * Loopback never leaves the host, and 169.254/16 is what an adapter
 * assigns itself when DHCP found nobody — an address whose presence
 * means the opposite of connectivity. Both are properties of the
 * address itself, not adapters named in a list somewhere.
 */
function isRoutable(address: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(address)) return false;
  if (address.startsWith("127.")) return false;
  if (address.startsWith("169.254.")) return false;
  return address !== "0.0.0.0";
}

/**
 * Compare on whichever identifier both sides actually carry. Linux
 * speaks in names, Windows in indices, and neither translates for free.
 */
function sameInterface(address: HostAddress, route: DefaultRoute): boolean {
  if (route.interfaceIndex !== null && address.interfaceIndex !== null) {
    return route.interfaceIndex === address.interfaceIndex;
  }
  if (route.interfaceName !== null && address.interfaceName !== null) {
    return route.interfaceName === address.interfaceName;
  }
  return false;
}

/**
 * Follow the route to the address, or return nothing.
 *
 * Routes are tried cheapest first, and a route whose interface holds no
 * usable address falls through to the next rather than ending the
 * search: a metric-5 adapter sitting on an APIPA address is exactly the
 * disconnected case, and the machine still answers on the one below it.
 */
export function addressFromRoutes(
  routes: DefaultRoute[],
  addresses: HostAddress[],
): string | null {
  for (const route of [...routes].sort((a, b) => a.metric - b.metric)) {
    if (route.source !== null && isRoutable(route.source)) return route.source;
    const held = addresses.find((a) => sameInterface(a, route) && isRoutable(a.address));
    if (held) return held.address;
  }
  return null;
}

/**
 * Interface names are compared the way they are read: off a screen,
 * out of a menu, into a JSON file by hand. "vEthernet (WSL)" typed as
 * "vethernet (wsl)" names the same adapter, and a pin that fails on
 * capitalisation fails silently — it looks exactly like an interface
 * that has gone away.
 */
function sameName(name: string | null, wanted: string): boolean {
  return name !== null && name.trim().toLowerCase() === wanted;
}

/**
 * The reachable address held on a named interface, or null when the
 * machine has no such interface or it holds nothing worth showing.
 *
 * `isRoutable` applies here exactly as it does to the route's answer: an
 * adapter sitting on its own 169.254 address has no address, whatever
 * the pin says, and saying so is what lets the caller fall back.
 */
export function addressOnInterface(addresses: HostAddress[], name: string): string | null {
  const wanted = name.trim().toLowerCase();
  if (wanted === "") return null;
  const held = addresses.find((a) => sameName(a.interfaceName, wanted) && isRoutable(a.address));
  return held?.address ?? null;
}

/**
 * The whole rule: the pinned interface when there is one and it can
 * answer, the default route otherwise.
 */
export function addressFor(state: NetState, pin: string | null): string | null {
  if (pin !== null) {
    const pinned = addressOnInterface(state.addresses, pin);
    if (pinned !== null) return pinned;
  }
  return addressFromRoutes(state.routes, state.addresses);
}

/**
 * The interfaces worth offering as a pin: those holding an address
 * another machine could reach, one entry each.
 *
 * Loopback and a disconnected adapter are left out because pinning them
 * resolves to the default route anyway — a menu entry that does nothing
 * is worse than an absent one, since choosing it looks like it worked.
 */
export function routableInterfaces(state: NetState): Array<{ name: string; address: string }> {
  const found: Array<{ name: string; address: string }> = [];
  const seen = new Set<string>();
  for (const held of state.addresses) {
    if (held.interfaceName === null || !isRoutable(held.address)) continue;
    const name = held.interfaceName.trim();
    const key = name.toLowerCase();
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    found.push({ name, address: held.address });
  }
  return found;
}

// ----------------------------------------------------------------- linux

function tokenAfter(tokens: string[], key: string): string | null {
  const at = tokens.indexOf(key);
  if (at < 0) return null;
  return tokens[at + 1] ?? null;
}

/** Parse `ip -4 route show default`. Anything else is not a default route. */
export function parseLinuxDefaultRoutes(out: string): DefaultRoute[] {
  const routes: DefaultRoute[] = [];
  for (const line of out.split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (tokens[0] !== "default") continue;
    routes.push({
      interfaceName: tokenAfter(tokens, "dev"),
      interfaceIndex: null,
      metric: Number(tokenAfter(tokens, "metric") ?? "") || 0,
      source: tokenAfter(tokens, "src"),
    });
  }
  return routes;
}

/** Parse `ip -o -4 addr show`, one interface per line by construction. */
export function parseLinuxAddresses(out: string): HostAddress[] {
  const addresses: HostAddress[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\d+):\s+(\S+)\s+inet\s+([\d.]+)/.exec(line.trim());
    if (!m || m[1] === undefined || m[2] === undefined || m[3] === undefined) continue;
    addresses.push({
      interfaceName: m[2],
      interfaceIndex: Number.parseInt(m[1], 10),
      address: m[3],
    });
  }
  return addresses;
}

async function linuxNetState(capture: Capture): Promise<NetState> {
  const routes = await capture(["ip", "-4", "route", "show", "default"]);
  if (routes.code !== 0) return NOTHING;
  const addresses = await capture(["ip", "-o", "-4", "addr", "show"]);
  return {
    routes: parseLinuxDefaultRoutes(routes.out),
    addresses: addresses.code === 0 ? parseLinuxAddresses(addresses.out) : [],
  };
}

// --------------------------------------------------------------- windows

/**
 * One round trip for both halves, because two would be two chances for
 * the table to change underneath us — an adapter coming up between the
 * calls yields a route pointing at an interface the address list has
 * never heard of.
 *
 * `RouteMetric` alone does not order Windows routes; the interface
 * metric is added to it, and it is the sum that decides. Errors are
 * silenced rather than thrown so a machine missing the NetTCPIP module
 * produces empty lists, which the rule already reads as "no answer".
 */
const WINDOWS_NET_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |" +
    " ForEach-Object { [pscustomobject]@{ index = [int]$_.InterfaceIndex;" +
    " metric = [int]$_.RouteMetric; interfaceMetric = [int]$_.InterfaceMetric } })",
  "$addresses = @(Get-NetIPAddress -AddressFamily IPv4 |" +
    " ForEach-Object { [pscustomobject]@{ index = [int]$_.InterfaceIndex;" +
    " name = [string]$_.InterfaceAlias; address = [string]$_.IPAddress } })",
  "[pscustomobject]@{ routes = $routes; addresses = $addresses } |" +
    " ConvertTo-Json -Depth 3 -Compress",
].join("; ");

type Record_ = { [key: string]: unknown };

/** PowerShell serialises a one-element list as a bare object often enough. */
function records(value: unknown): Record_[] {
  const many = Array.isArray(value) ? value : [value];
  return many.filter((v): v is Record_ => typeof v === "object" && v !== null);
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOf(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function parseWindowsNetState(json: string): NetState {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    // PowerShell writes its errors where the JSON was meant to go, and
    // a machine that cannot answer is not a machine to guess about.
    return NOTHING;
  }
  if (typeof payload !== "object" || payload === null) return NOTHING;
  const root = payload as Record_;

  const routes: DefaultRoute[] = [];
  for (const route of records(root["routes"])) {
    const index = numberOf(route["index"]);
    if (index === null) continue;
    routes.push({
      interfaceName: null,
      interfaceIndex: index,
      metric: (numberOf(route["metric"]) ?? 0) + (numberOf(route["interfaceMetric"]) ?? 0),
      source: null,
    });
  }

  const addresses: HostAddress[] = [];
  for (const address of records(root["addresses"])) {
    const held = stringOf(address["address"]);
    if (held === null) continue;
    addresses.push({
      interfaceName: stringOf(address["name"]),
      interfaceIndex: numberOf(address["index"]),
      address: held,
    });
  }

  return { routes, addresses };
}

async function windowsNetState(capture: Capture): Promise<NetState> {
  const { out, code } = await capture(["powershell.exe", "-NoProfile", "-Command", WINDOWS_NET_SCRIPT]);
  if (code !== 0) return NOTHING;
  return parseWindowsNetState(out);
}

// ------------------------------------------------------------- the seam

async function spawnCapture(cmd: string[]): Promise<Captured> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    // PowerShell reached through WSL interop writes UTF-16LE when its
    // stdout is redirected, which is not JSON until it is decoded.
    const out = await readWindowsOutput(proc.stdout);
    return { out, code: await proc.exited };
  } catch {
    // A binary that is not there is an answer, not an exception: this
    // machine cannot be asked, so it reports nothing.
    return { out: "", code: 127 };
  }
}

/**
 * What this machine says about its own addresses. WSL asks the Windows
 * host; everything else asks itself.
 *
 * Exported because the menu offering a pin needs the same list this
 * resolves against — offering an interface the resolver has never heard
 * of is offering a pin that cannot work.
 */
export async function hostNetState(
  p: Platform,
  capture: Capture = spawnCapture,
): Promise<NetState> {
  if (p.os === "windows" || p.env === "wsl") return await windowsNetState(capture);
  if (p.os === "linux") return await linuxNetState(capture);
  return NOTHING;
}

/**
 * The address to show for this machine, or null when it has none worth
 * showing.
 *
 * The pin is a parameter rather than a read, so this stays the pure
 * question "what does this machine answer on, given this preference" —
 * `resolveRedwallAddress` is the one that knows where the preference is
 * kept.
 */
export async function resolveLanAddress(
  p: Platform,
  capture: Capture = spawnCapture,
  pin: string | null = null,
): Promise<string | null> {
  return addressFor(await hostNetState(p, capture), pin);
}

/**
 * The address Redwall reports: this machine's, through whatever the
 * person configured.
 *
 * The entry point a caller wants. Reaching for `resolveLanAddress`
 * without a pin is how a stored preference quietly stops being read.
 */
export async function resolveRedwallAddress(
  p: Platform,
  capture: Capture = spawnCapture,
): Promise<string | null> {
  return await resolveLanAddress(p, capture, await resolveRedwallInterface(p));
}
