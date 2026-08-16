/**
 * The network and DNS Panel: what this machine is joined to, which
 * resolver answers for it, and the four things an operator can do about
 * that.
 *
 * The first Panel, and the shape the rest are meant to copy. A Panel is
 * a red-dev TUI over one host subsystem, and it earns that by driving
 * the platform's *first-party* CLI rather than writing the files
 * underneath it — `nmcli` and `resolvectl` on Ubuntu, the NetTCPIP and
 * DnsClient cmdlets on Windows. Editing `/etc/resolv.conf` by hand would
 * work for about one reboot on a machine NetworkManager owns, and would
 * leave the host's own tools disagreeing with the Panel about what the
 * machine is configured to do.
 *
 * ## Looking is never privileged
 *
 * Every command in `observePlan` is a read, and none of them asks the
 * machine for rights. That is not an accident of which cmdlets happened
 * to be convenient: it is the promise that makes the Panel worth opening
 * at all. A network view that raised a UAC dialog to *show* you the DNS
 * would be a dialog people learn to dismiss, and the next one — the one
 * that changes something — would be dismissed with it. A test pins that
 * no observation argv reaches for `sudo` or `RunAs`.
 *
 * ## Changing asks inline, at that moment
 *
 * Switching DNS does need rights, and the Panel asks for them there and
 * then — `sudo` on Ubuntu, the UAC consent `Start-Process -Verb RunAs`
 * raises on Windows — because it is an operator asking for a change now.
 * It never queues the act into `red-dev privileged`, the converge's
 * single-consent batch (decision of 2026-08-15, `interaction/CONTEXT.md`).
 * The batch exists so that "make this machine correct" costs one prompt
 * at the end of a long run; a Panel act belongs to neither that run nor
 * that prompt, and putting it there would mean the DNS an operator chose
 * takes effect at the end of the next converge. Those are different
 * things and they stay different.
 *
 * ## WSL asks the Windows host
 *
 * The same crossing `lan-address.ts` and `ssh-server.ts` already make,
 * and for the same reason: a WSL distro has no network of its own to
 * join and no NetworkManager to ask. Its `/etc/resolv.conf` is generated
 * from the host, so the DNS that answers inside the distro is the host's
 * DNS — and the honest place to change it is the host. That is why
 * `panelTarget` folds WSL into `windows` rather than giving it a target
 * of its own.
 *
 * ## Both address families, or the change does not take
 *
 * Each named choice carries its IPv4 *and* IPv6 servers. Setting only
 * the v4 half on a dual-stack network leaves the router answering over
 * v6, which is the worst kind of outcome: the Panel would report success
 * and the machine would go on resolving through the resolver the
 * operator just replaced. Observation reads both families too, so what
 * the Panel shows after a change is what the machine actually holds.
 */

import type { Platform } from "./platform.ts";
import type { Gate } from "./rights.ts";

/**
 * The two adapters this Panel has.
 *
 * Not one per `Env`: Ubuntu desktop and an Ubuntu server drive the same
 * two binaries, and WSL drives the Windows ones. Darwin and an unknown
 * OS are absent deliberately, failing closed as `providerFor` does and
 * as ADR 0001 requires.
 */
export type PanelTarget = "linux" | "windows";

/**
 * Which CLI answers for this machine, or nothing when none does.
 *
 * Windows first, and WSL with it, in the same order `hostNetState` asks
 * the question — a WSL distro is `os: "linux"`, so testing Linux first
 * would send it to `nmcli`, which is not installed and would not be
 * describing the right machine if it were.
 */
export function panelTarget(p: Platform): PanelTarget | null {
  if (p.os === "windows" || p.env === "wsl") return "windows";
  if (p.os === "linux") return "linux";
  return null;
}

/** The four, in the order the Panel offers them. */
export type DnsChoice = "dhcp" | "cloudflare" | "google" | "custom";

export const DNS_CHOICES: readonly DnsChoice[] = ["dhcp", "cloudflare", "google", "custom"];

/** What the Panel calls each one, and the sentence under it. */
export const DNS_LABELS: Record<DnsChoice, { label: string; detail: string }> = {
  dhcp: { label: "DHCP", detail: "whatever the network hands out" },
  cloudflare: { label: "Cloudflare", detail: "1.1.1.1" },
  google: { label: "Google", detail: "8.8.8.8" },
  custom: { label: "Custom", detail: "resolvers you type" },
};

/**
 * The addresses behind the two named choices, both families each.
 *
 * Written down rather than resolved, because a resolver's own address
 * cannot be looked up by the resolver being replaced. The v6 halves are
 * the published ones and are as load-bearing as the v4 halves — see the
 * header on why setting only one family is worse than setting neither.
 */
const NAMED_SERVERS: Record<"cloudflare" | "google", readonly string[]> = {
  cloudflare: ["1.1.1.1", "1.0.0.1", "2606:4700:4700::1111", "2606:4700:4700::1001"],
  google: ["8.8.8.8", "8.8.4.4", "2001:4860:4860::8888", "2001:4860:4860::8844"],
};

/**
 * An address a resolver could plausibly live at.
 *
 * A guard rather than a parser. These strings become argv words for
 * `nmcli`, where no shell ever sees them, and a single-quoted PowerShell
 * literal, where `psQuote` doubles the quotes — so this is not what
 * stands between a typed value and the machine. What it is for is the
 * other failure: a typo accepted silently, written to the connection,
 * and discovered as a machine that resolves nothing.
 */
function isAddress(text: string): boolean {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split(".").every((octet) => Number.parseInt(octet, 10) <= 255);
  }
  return text.includes(":") && /^[0-9a-f:]+$/i.test(text);
}

/**
 * Read what was typed into the custom field: addresses separated by
 * whatever the person reached for.
 *
 * Commas and spaces both, because both are how DNS servers are written
 * down everywhere else, and a field that accepts one and silently drops
 * the other is a field that loses the second resolver.
 */
export function readServers(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

/**
 * The servers a choice names, or null when the choice cannot be honoured.
 *
 * DHCP names none, and that is a value rather than an absence: it is the
 * choice that hands the question back to the network.
 */
export function serversFor(choice: DnsChoice, custom = ""): readonly string[] | null {
  if (choice === "dhcp") return [];
  if (choice !== "custom") return NAMED_SERVERS[choice];
  const typed = readServers(custom);
  if (typed.length === 0 || !typed.every(isAddress)) return null;
  return typed;
}

// ----------------------------------------------------------- the plans

/**
 * What the Panel would run, decided before anything runs.
 *
 * The same split `firePlan` makes, for the same reason: a plan can be
 * read by a test, and a refusal arrives as a sentence for the status
 * line rather than as a process that failed off screen. It is also what
 * makes "observation is never privileged" a checkable claim instead of a
 * paragraph — `gate` says which gate the acts pass, and `raisesRights`
 * reads the argv itself, so a plan cannot claim `null` while quietly
 * carrying a `sudo`.
 */
export interface PanelPlan {
  /**
   * The one visible ask that raises the rights, before the acts.
   *
   * `sudo -v` on Ubuntu, so the password is typed once, in the ordinary
   * terminal, at the moment the operator asked — the same shape
   * `primeSudoInteractive` uses before the installer takes the screen.
   * Null on Windows, where consent is not a separate question: the UAC
   * dialog is raised by the act itself and cannot be raised early.
   */
  prime: readonly string[] | null;
  /** The acts, in order, each already carrying the rights it needs. */
  steps: readonly (readonly string[])[];
  /** Which gate those acts pass, or null when they pass none. */
  gate: Gate | null;
  /** One line, for the status line under the list. */
  note: string;
}

/**
 * Does this argv ask the machine for rights?
 *
 * Read off the words rather than taken on trust, because the claim worth
 * pinning is about what runs. Both spellings of each gate are here: the
 * Linux elevators as argv[0], and Windows' consent verb as it appears
 * inside a `-Command` string, where no amount of looking at argv[0]
 * would find it.
 */
export function raisesRights(argv: readonly string[]): boolean {
  const head = argv[0]?.toLowerCase().replace(/\.exe$/, "") ?? "";
  if (["sudo", "pkexec", "doas", "su", "runas"].includes(head)) return true;
  return argv.some((word) => /-verb\s+runas/i.test(word));
}

/**
 * The reads. Two commands on Ubuntu, one round trip on Windows.
 *
 * Ubuntu is asked twice because the two answers come from two programs
 * and neither can speak for the other: NetworkManager knows which
 * network is joined and on what link, and systemd-resolved knows what
 * answers DNS on that link. Windows is asked once, for the reason
 * `lan-address.ts` gives — two round trips are two chances for the
 * adapter table to change underneath us.
 */
export function observeArgv(target: PanelTarget): readonly (readonly string[])[] {
  if (target === "linux") {
    return [
      // Terse and field-selected: the human-readable form re-flows with
      // the terminal width, and a parser that reads columns off it
      // starts failing the day a device name gets longer.
      ["nmcli", "-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device", "status"],
      ["resolvectl", "dns"],
    ];
  }
  return [["powershell.exe", "-NoProfile", "-Command", WINDOWS_OBSERVE]];
}

/**
 * Observation as a plan, so it can be held to the same rule the changes
 * are.
 *
 * `gate: null` is the claim; `observeArgv` is the evidence. Keeping them
 * in one object is what lets one test read both.
 */
export function observePlan(target: PanelTarget): PanelPlan {
  return {
    prime: null,
    steps: observeArgv(target),
    gate: null,
    note: "reads this machine and changes nothing",
  };
}

/**
 * The whole Windows read, in one script.
 *
 * Three cmdlets because the answer has three parts, and each is the
 * first-party one for its part: `Get-NetConnectionProfile` names the
 * network that was joined, `Get-NetAdapter` says whether the link is up,
 * and `Get-DnsClientServerAddress` says what answers on it. Every one is
 * a `Get-`, which is the whole reason opening this Panel needs nothing.
 *
 * No `-AddressFamily` filter on the DNS query: the Panel sets both
 * families, so it has to be able to see both, and a v4-only read would
 * show a machine as "Cloudflare" while a router still answered over v6.
 *
 * Errors are silenced rather than thrown, exactly as the neighbouring
 * probe in `lan-address.ts` does — a machine missing the NetTCPIP module
 * produces empty lists, which the parser already reads as "no answer".
 */
const WINDOWS_OBSERVE = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$profiles = @(Get-NetConnectionProfile |" +
    " ForEach-Object { [pscustomobject]@{ index = [int]$_.InterfaceIndex;" +
    " name = [string]$_.Name; alias = [string]$_.InterfaceAlias } })",
  "$adapters = @(Get-NetAdapter |" +
    " ForEach-Object { [pscustomobject]@{ index = [int]$_.ifIndex;" +
    " alias = [string]$_.Name; status = [string]$_.Status } })",
  "$dns = @(Get-DnsClientServerAddress |" +
    " ForEach-Object { [pscustomobject]@{ index = [int]$_.InterfaceIndex;" +
    " servers = @($_.ServerAddresses) } })",
  "[pscustomobject]@{ profiles = $profiles; adapters = $adapters; dns = $dns } |" +
    " ConvertTo-Json -Depth 4 -Compress",
].join("; ");

/** One PowerShell string literal, with the quotes inside it doubled. */
function psQuote(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Chosen, and the argv that carries it out — or the reason it cannot. */
export type DnsPlan =
  | ({ ok: true; choice: DnsChoice; servers: readonly string[] } & PanelPlan)
  | { ok: false; choice: DnsChoice; detail: string };

/**
 * What switching DNS to `choice` costs, given what the Panel is showing.
 *
 * Built from the observed view rather than from a target and a name,
 * and that is the point: `view.handle` is what the platform's own CLI
 * takes back — the NetworkManager connection on Ubuntu, the interface
 * index on Windows — so the link this changes is by construction the
 * link on screen. A Panel that changed the DNS of some other adapter
 * would be the quietest possible bug, and taking the link as a separate
 * argument is how that bug gets written.
 */
export function dnsPlan(view: NetworkView, choice: DnsChoice, custom = ""): DnsPlan {
  const target = view.target;
  const link = view.handle;

  if (target === null) {
    return {
      ok: false,
      choice,
      detail: "red-dev has no network adapter for this platform",
    };
  }

  if (link === null || link.trim() === "") {
    // Refused rather than guessed at. "The default link" is not a thing
    // either CLI has, and picking one here would mean changing the DNS
    // of whichever adapter happened to sort first.
    return {
      ok: false,
      choice,
      detail: "no joined network to change — nothing here reports a link to set DNS on",
    };
  }

  const servers = serversFor(choice, custom);
  if (servers === null) {
    return {
      ok: false,
      choice,
      detail: custom.trim() === ""
        ? "type one or more resolver addresses first"
        : `not an address: ${readServers(custom).filter((s) => !isAddress(s)).join(", ")}`,
    };
  }

  // Named for a person, not for the CLI: on Windows the handle is an
  // interface index, and "Cloudflare on 12" is not a sentence anybody
  // wants read back to them after typing their password.
  const note = `${DNS_LABELS[choice].label} on ${view.network ?? view.device ?? link}`;

  if (target === "linux") {
    return {
      ok: true,
      choice,
      servers,
      // Asked once, visibly, before the acts. The acts themselves use
      // `-n` so that if the credential did not survive — a long pause, a
      // policy that does not cache — they fail with a named refusal
      // instead of stopping at a hidden password prompt behind a frame.
      prime: ["sudo", "-v"],
      steps: linuxSteps(link, servers),
      gate: "sudo",
      note,
    };
  }

  return {
    ok: true,
    choice,
    servers,
    prime: null,
    steps: [windowsStep(link, servers)],
    gate: "administrator",
    note,
  };
}

/**
 * NetworkManager, in two acts: record the choice on the connection, then
 * bring the connection up so it takes effect now.
 *
 * `ignore-auto-dns` is the half that is easy to leave out and fatal to.
 * Setting `ipv4.dns` alone *adds* resolvers alongside the ones DHCP
 * supplied; the machine keeps asking the router first and the Panel
 * reports a change that did nothing. Setting it back to `no` with an
 * empty list is what "DHCP" means as an act.
 *
 * The second act is not a nicety either: `connection modify` writes the
 * profile and leaves the live connection exactly as it was, so a Panel
 * without it would be correct about the next reboot and wrong about now.
 *
 * The flag is decided per address family, from whether that family got
 * any servers — which makes DHCP fall out of the same rule rather than
 * needing a branch, since it supplies none of either. It is also what
 * keeps the two targets honest with each other: Windows' cmdlet only
 * touches the families it is given addresses for, so a custom entry of
 * one IPv4 address leaves IPv6 on the network's resolver on both, rather
 * than on Windows only.
 */
function linuxSteps(connection: string, servers: readonly string[]): string[][] {
  const family = (want: (s: string) => boolean): [string, string] => {
    const held = servers.filter(want);
    return [held.length === 0 ? "no" : "yes", held.join(" ")];
  };
  const [autoV4, v4] = family((s) => !s.includes(":"));
  const [autoV6, v6] = family((s) => s.includes(":"));
  return [
    [
      "sudo",
      "-n",
      "nmcli",
      "connection",
      "modify",
      connection,
      "ipv4.ignore-auto-dns",
      autoV4,
      "ipv4.dns",
      v4,
      "ipv6.ignore-auto-dns",
      autoV6,
      "ipv6.dns",
      v6,
    ],
    ["sudo", "-n", "nmcli", "connection", "up", connection],
  ];
}

/**
 * Windows, in one act, because consent is the act.
 *
 * `Start-Process -Verb RunAs` is what raises the UAC dialog, and there
 * is no way to raise it earlier and hold it — which is why this target
 * has no `prime`. `-Wait` so the Panel re-reads the machine after the
 * child has finished rather than beside it.
 *
 * `Clear-DnsClientCache` rides along inside the elevated command. The
 * cmdlet before it changes which resolver is asked; the cache is what
 * decides whether anything asks at all, and a Panel that reported
 * Cloudflare while the machine kept answering from Google's old replies
 * would be telling the truth about configuration and lying about
 * behaviour.
 */
function windowsStep(index: string, servers: readonly string[]): string[] {
  const set = servers.length === 0
    ? `Set-DnsClientServerAddress -InterfaceIndex ${index} -ResetServerAddresses`
    : `Set-DnsClientServerAddress -InterfaceIndex ${index} -ServerAddresses ` +
      servers.map(psQuote).join(",");
  const inner = `${set}; Clear-DnsClientCache`;
  return [
    "powershell.exe",
    "-NoProfile",
    "-Command",
    "Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden " +
      `-ArgumentList '-NoProfile','-Command',${psQuote(inner)}`,
  ];
}

// ------------------------------------------------------------ the view

/** Up, down, or the machine would not say. */
export type LinkState = "up" | "down" | "unknown";

/** What the Panel shows, once the machine has been asked. */
export interface NetworkView {
  target: PanelTarget | null;
  /** The network as a person names it — an SSID, a wired profile. */
  network: string | null;
  /** The adapter it is on, as the platform names it. */
  device: string | null;
  /**
   * What this platform's CLI takes back to change this link: the
   * NetworkManager connection on Ubuntu, the interface index on Windows.
   *
   * Kept apart from `device` because they are the same thing only by
   * coincidence. A connection can be called "Wired connection 1" while
   * the device is `enp3s0`, and handing `nmcli connection modify` the
   * device name changes nothing while succeeding.
   */
  handle: string | null;
  state: LinkState;
  /** The resolvers answering on that link, in the order the CLI gave them. */
  servers: string[];
  /**
   * Which named choice those resolvers are, when they are one.
   *
   * Null covers both "something else" and DHCP, and it stays null for
   * DHCP on purpose: neither CLI's read tells you whether an address was
   * handed out or typed in, and a Panel that guessed "DHCP" from a
   * router's address would be wrong on every machine that has pinned it.
   */
  named: "cloudflare" | "google" | null;
}

const NOTHING: NetworkView = {
  target: null,
  network: null,
  device: null,
  handle: null,
  state: "unknown",
  servers: [],
  named: null,
};

/** Ran, and what it printed. Same shape as `lan-address.ts`'s. */
export interface Captured {
  out: string;
  code: number;
}

/** The seam the tests replace: how a question reaches the machine. */
export type Capture = (cmd: readonly string[]) => Promise<Captured>;

/**
 * Whether the observed resolvers are one of the named choices.
 *
 * By set rather than by sequence: `resolvectl` and the DnsClient cmdlets
 * do not promise an order, and a machine that holds 1.0.0.1 before
 * 1.1.1.1 is on Cloudflare by any reading a person would give it.
 */
export function namedChoice(servers: readonly string[]): "cloudflare" | "google" | null {
  const held = new Set(servers.map((s) => s.toLowerCase()));
  for (const name of ["cloudflare", "google"] as const) {
    const want = NAMED_SERVERS[name];
    // Every held address belongs to the choice, and at least one of the
    // choice's is held. Subset rather than equality, because a machine
    // with no IPv6 at all holds only the two v4 addresses and is still,
    // plainly, on Cloudflare.
    if (held.size > 0 && [...held].every((s) => want.some((w) => w.toLowerCase() === s))) {
      return name;
    }
  }
  return null;
}

// ------------------------------------------------------------ ubuntu

/**
 * One `nmcli -t` line, split on the separator it escapes.
 *
 * `-t` escapes a colon inside a value as `\:` and a backslash as `\\`,
 * which a plain `split(":")` walks straight past — and the value most
 * likely to contain a colon is the connection name, which is the field
 * everything downstream takes back to `nmcli`.
 */
export function terseFields(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "\\" && i + 1 < line.length) {
      current += line[++i];
      continue;
    }
    if (ch === ":") {
      fields.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  fields.push(current);
  return fields;
}

interface Device {
  device: string;
  type: string;
  state: string;
  connection: string;
}

/** Parse `nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status`. */
export function parseDevices(out: string): Device[] {
  const devices: Device[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const [device, type, state, connection] = terseFields(line);
    if (device === undefined || type === undefined || state === undefined) continue;
    devices.push({ device, type, state, connection: connection ?? "" });
  }
  return devices;
}

/**
 * The device the machine is joined through.
 *
 * Ethernet and Wi-Fi first, and connected first, because those are the
 * links a person means by "the network". Loopback is never it. A machine
 * with nothing connected still yields its best candidate rather than
 * null, so the Panel can say "down" about a real adapter instead of
 * saying nothing about the machine.
 */
export function joinedDevice(devices: readonly Device[]): Device | null {
  const real = devices.filter((d) => d.type !== "loopback");
  const physical = real.filter((d) => d.type === "ethernet" || d.type === "wifi");
  return (
    physical.find((d) => d.state === "connected") ??
    real.find((d) => d.state === "connected") ??
    physical[0] ??
    real[0] ??
    null
  );
}

/**
 * Parse `resolvectl dns` into the servers held per link.
 *
 * The `Global:` block is deliberately not merged in. It is the fallback
 * for links that name none of their own, and folding it into every link
 * would show a machine as configured where it is merely defaulting.
 */
export function parseResolvectlDns(out: string): Record<string, string[]> {
  const byLink: Record<string, string[]> = {};
  for (const line of out.split(/\r?\n/)) {
    const m = /^Link\s+\d+\s+\(([^)]+)\):(.*)$/.exec(line.trim());
    if (!m || m[1] === undefined) continue;
    byLink[m[1]] = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
  }
  return byLink;
}

function linkState(nmcliState: string): LinkState {
  if (nmcliState === "connected") return "up";
  if (nmcliState === "disconnected" || nmcliState === "unavailable") return "down";
  return "unknown";
}

async function observeLinux(capture: Capture): Promise<NetworkView> {
  const [status, dns] = observeArgv("linux");
  // Not `?? []` on the argv: these two are pinned by a test, and a
  // missing one is a programming error rather than a machine's answer.
  const devices = status ? await capture(status) : { out: "", code: 127 };
  const resolvers = dns ? await capture(dns) : { out: "", code: 127 };

  const joined = devices.code === 0 ? joinedDevice(parseDevices(devices.out)) : null;
  if (!joined) return { ...NOTHING, target: "linux" };

  const held = resolvers.code === 0 ? parseResolvectlDns(resolvers.out) : {};
  const servers = held[joined.device] ?? [];

  return {
    target: "linux",
    // The connection name, not the device: it is what a person named the
    // network, and on Wi-Fi it is the SSID.
    network: joined.connection === "" ? null : joined.connection,
    device: joined.device,
    handle: joined.connection === "" ? null : joined.connection,
    state: linkState(joined.state),
    servers,
    named: namedChoice(servers),
  };
}

// ----------------------------------------------------------- windows

type Record_ = { [key: string]: unknown };

/**
 * PowerShell serialises a one-element list as a bare object often
 * enough. The twins of these three live in `lan-address.ts`, beside the
 * other probe that has to read what `ConvertTo-Json` felt like emitting.
 */
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

function strings(value: unknown): string[] {
  const many = Array.isArray(value) ? value : [value];
  return many.map(stringOf).filter((s): s is string => s !== null);
}

/**
 * Read what the Windows script printed.
 *
 * The connection profile is the anchor: it is the only one of the three
 * that knows a network was *joined*, and an adapter with no profile is
 * an adapter that is up and attached to nothing.
 */
export function parseWindowsView(json: string): NetworkView {
  let payload: unknown;
  try {
    payload = JSON.parse(json);
  } catch {
    // PowerShell writes its errors where the JSON was meant to go, and a
    // machine that cannot answer is not a machine to guess about.
    return { ...NOTHING, target: "windows" };
  }
  if (typeof payload !== "object" || payload === null) return { ...NOTHING, target: "windows" };
  const root = payload as Record_;

  const profile = records(root["profiles"]).find((r) => numberOf(r["index"]) !== null);
  if (!profile) return { ...NOTHING, target: "windows" };
  const index = numberOf(profile["index"]) as number;

  const adapter = records(root["adapters"]).find((r) => numberOf(r["index"]) === index);
  const status = adapter ? (stringOf(adapter["status"]) ?? "") : "";

  const servers = records(root["dns"])
    .filter((r) => numberOf(r["index"]) === index)
    .flatMap((r) => strings(r["servers"]));

  return {
    target: "windows",
    network: stringOf(profile["name"]),
    device: stringOf(profile["alias"]) ?? (adapter ? stringOf(adapter["alias"]) : null),
    // The index, because that is what Set-DnsClientServerAddress takes
    // and it survives an adapter being renamed mid-session.
    handle: String(index),
    state: windowsLinkState(status),
    servers,
    named: namedChoice(servers),
  };
}

/**
 * `Get-NetAdapter` reports a status word, and only one of them means up.
 *
 * "Not Present" and an empty string are `unknown` rather than `down`:
 * the first is an adapter Windows cannot see and the second is a probe
 * that answered nothing, and reporting either as down would be a claim
 * about a machine that made none.
 */
function windowsLinkState(status: string): LinkState {
  const word = status.trim().toLowerCase();
  if (word === "up") return "up";
  if (word === "disconnected" || word === "disabled") return "down";
  return "unknown";
}

// ------------------------------------------------------------- the seam

/**
 * Ask the machine, with the child's streams captured.
 *
 * The same shape `lan-address.ts` uses, including the UTF-16LE decode:
 * PowerShell reached through WSL interop writes UTF-16LE when its stdout
 * is redirected, which is not JSON until it is decoded.
 */
export async function spawnCapture(cmd: readonly string[]): Promise<Captured> {
  const { readWindowsOutput } = await import("./windows-output.ts");
  try {
    const proc = Bun.spawn([...cmd], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const out = await readWindowsOutput(proc.stdout);
    return { out, code: await proc.exited };
  } catch {
    // A binary that is not there is an answer, not an exception: this
    // machine cannot be asked, so it reports nothing.
    return { out: "", code: 127 };
  }
}

/** What this machine says about the network it is on. */
export async function observeNetwork(
  p: Platform,
  capture: Capture = spawnCapture,
): Promise<NetworkView> {
  const target = panelTarget(p);
  if (target === null) return NOTHING;
  if (target === "linux") return await observeLinux(capture);

  const [argv] = observeArgv("windows");
  if (!argv) return { ...NOTHING, target };
  const { out, code } = await capture(argv);
  if (code !== 0) return { ...NOTHING, target };
  return parseWindowsView(out);
}

/**
 * The view as text, for a terminal with no Panel to draw.
 *
 * Not a degraded mode: this is the form a bug report pastes and a script
 * greps, and it carries the same three facts the drawn Panel leads with.
 * What it does not carry is the ability to change anything — see the
 * note on `cmdPanel` about why there is no `--dns` flag.
 */
export function panelLines(view: NetworkView): string[] {
  const named = view.named === null ? "" : ` (${DNS_LABELS[view.named].label})`;
  return [
    `network  ${view.network ?? "not joined"}`,
    `link     ${view.device ?? "none"} — ${view.state}`,
    `dns      ${view.servers.length === 0 ? "none reported" : view.servers.join(" ")}${named}`,
  ];
}

// -------------------------------------------------------- the keyboard

/** Where the cursor is, and what has been typed into the custom field. */
export interface PanelState {
  /** Into `DNS_CHOICES`, never past its end. */
  index: number;
  /** Only meaningful while the custom row is highlighted. */
  custom: string;
}

export const PANEL_START: PanelState = { index: 0, custom: "" };

/**
 * The keys the Panel reads, structurally — the same declaration
 * `keys.ts` makes, and for the same reason: tuiuiu's `Key` carries all
 * of these, so the component hands its own object straight in, and
 * naming only what is used keeps this module free of the renderer.
 */
export interface PanelKey {
  upArrow: boolean;
  downArrow: boolean;
  return: boolean;
  escape: boolean;
  backspace: boolean;
  delete: boolean;
  ctrl: boolean;
}

export interface PanelStep {
  state: PanelState;
  /** The choice Enter asked for, when it asked for one. */
  apply?: DnsChoice;
  /** The Panel is finished. */
  quit?: boolean;
}

/**
 * One keystroke, as a decision rather than as a side effect.
 *
 * Typing edits the custom field only while the custom row is
 * highlighted. Everywhere else it is swallowed: this is a list of four
 * things, not a search box, and a stray letter that silently filled a
 * field three rows down would be a change nobody asked for.
 *
 * Escape clears the field before it closes the Panel, the same two-step
 * the keys viewer makes — someone who mistyped an address is one
 * keystroke from an empty field rather than out of the program.
 */
export function panelStep(state: PanelState, input: string, key: PanelKey): PanelStep {
  const clamp = (i: number): number => Math.max(0, Math.min(DNS_CHOICES.length - 1, i));
  const onCustom = DNS_CHOICES[state.index] === "custom";

  // Ctrl+C leaves, whatever is on screen. Every other Ctrl chord is
  // swallowed rather than typed into the field.
  if (key.ctrl) return input === "c" ? { state, quit: true } : { state };

  if (key.return) {
    const chosen = DNS_CHOICES[clamp(state.index)];
    return chosen ? { state, apply: chosen } : { state };
  }

  if (key.escape) {
    return state.custom === "" ? { state, quit: true } : { state: { ...state, custom: "" } };
  }

  if (key.upArrow) return { state: { ...state, index: clamp(state.index - 1) } };
  if (key.downArrow) return { state: { ...state, index: clamp(state.index + 1) } };

  if (key.backspace || key.delete) {
    return onCustom && state.custom !== ""
      ? { state: { ...state, custom: state.custom.slice(0, -1) } }
      : { state };
  }

  if (onCustom && input.length === 1 && input >= " " && input !== "\u007f") {
    return { state: { ...state, custom: state.custom + input } };
  }

  return { state };
}

// -------------------------------------------------------------- doing it

/** Changed, or the reason it was not — either way, one line. */
export interface DnsOutcome {
  changed: boolean;
  detail: string;
}

/** Run one argv attached to the terminal, and say how it ended. */
export type Run = (argv: readonly string[]) => Promise<number>;

/**
 * Carry out a plan: the visible ask, then the acts, stopping at the
 * first one that fails.
 *
 * Stopping matters on Ubuntu, where the two acts are "record it" and
 * "make it take effect": running the second after the first failed would
 * bring the connection up with the DNS it already had and report that as
 * the change the operator asked for.
 */
export async function applyDns(plan: DnsPlan, run: Run): Promise<DnsOutcome> {
  if (!plan.ok) return { changed: false, detail: plan.detail };

  if (plan.prime) {
    const code = await run(plan.prime);
    if (code !== 0) {
      const { missingRights } = await import("./rights.ts");
      return { changed: false, detail: missingRights("sudo").cause };
    }
  }

  for (const step of plan.steps) {
    const code = await run(step);
    if (code !== 0) {
      const { missingRights } = await import("./rights.ts");
      // A non-zero exit from an elevated Start-Process is what a
      // declined UAC dialog looks like from here; there is no separate
      // signal for it, and the remedy is the same either way.
      const gate = plan.gate ?? "sudo";
      return { changed: false, detail: `${step[0]} failed — ${missingRights(gate).cause}` };
    }
  }

  return { changed: true, detail: `dns: ${plan.note}` };
}
