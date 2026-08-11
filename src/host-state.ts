/**
 * The daemon's host-state, reduced to what Redwall draws from it.
 *
 * `redskilled host-state` answers with everything the RedSkills daemon knows
 * about this machine — ceilings, budgets, registrations, birth latches, the
 * version it is holding at. Redwall wants one number out of that document:
 * how many Workers are running right now. Everything else is read past.
 *
 * ## Absent is a value, not a failure
 *
 * The whole of this module is one rule: **never withhold half the
 * information because the other half is unavailable.** Redwall composes a
 * Worker count and a LAN address over the theme's art, and the address is
 * resolved without the daemon's help. So a daemon that is not running, a
 * document this build cannot parse, and a document whose version it does not
 * recognise all produce the same thing — `null`, meaning "no Worker count" —
 * and none of them throws. The Redwall that results carries the address
 * alone, which is the picture the Spec settled on twice.
 *
 * `null` is therefore load-bearing, and it is not the same value as
 * `{ workers: 0 }`. A host whose queue has drained reports zero; a host
 * whose daemon is gone reports nothing. Collapsing the two would draw the
 * same wallpaper for "the work is done" and "the machine went quiet", which
 * is the one distinction the daemon's own document was built to preserve.
 *
 * ## Why the version is checked at all
 *
 * The daemon's contract is frozen and serves checkouts pinned to different
 * bundle versions, so a red-dev built today will meet daemons older and
 * newer than itself. `version` and `protocol_version` are how the document
 * says which contract it was written against, and this build understands
 * exactly one of each. Reading a document that declares another would be
 * guessing that a field kept its meaning across a release that said it did
 * not — and a guess that is wrong draws a confident, false number on
 * someone's desktop.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  runBounded,
  type BoundedCommandOptions,
  type BoundedCommandResult,
} from "./bounded-command.ts";

/** The document shape this build reads. Not a floor: an exact match. */
export const HOST_STATE_VERSION = 1;

/** The wire contract this build reads. Exact for the same reason. */
export const HOST_STATE_PROTOCOL_VERSION = 1;

/** What Redwall takes from the daemon. `null` in place of this is "unknown". */
export interface HostState {
  /** Workers running on this machine right now; zero is a real answer. */
  readonly workers: number;
}

export interface HostWorkerIdentity {
  readonly pid: number;
  readonly unit: string | null;
}

/** Full identity subset used to protect live Workers during Host Rescue. */
export interface HostInventory {
  readonly daemonPid: number;
  readonly workers: HostWorkerIdentity[];
}

export function hostInventoryFrom(value: unknown): HostInventory | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state["version"] !== HOST_STATE_VERSION) return null;
  if (state["protocol_version"] !== HOST_STATE_PROTOCOL_VERSION) return null;
  const daemonPid = state["pid"];
  if (!Number.isSafeInteger(daemonPid) || (daemonPid as number) <= 0) return null;
  const workers = state["workers"];
  if (!Array.isArray(workers)) return null;

  const identities: HostWorkerIdentity[] = [];
  for (const worker of workers) {
    if (worker === null || typeof worker !== "object" || Array.isArray(worker)) return null;
    const record = worker as Record<string, unknown>;
    const pid = record["pid"];
    const unit = record["unit"];
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0) return null;
    if (unit !== undefined && unit !== null && typeof unit !== "string") return null;
    identities.push({ pid: pid as number, unit: typeof unit === "string" ? unit : null });
  }
  return { daemonPid: daemonPid as number, workers: identities };
}

/**
 * The Worker count in a parsed host-state document, or null. PURE.
 *
 * Fail-closed by construction: every path that is not a document of the
 * exact version this build understands, carrying a Worker array, returns
 * null. `workers.length` rather than the `projects` block, because
 * `projects` is that same array grouped by label — one source, so the two
 * can never be seen to disagree — and rather than `ceiling.worker_count`,
 * which is what the machine would allow and not what it is running.
 */
export function hostStateFrom(value: unknown): HostState | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state["version"] !== HOST_STATE_VERSION) return null;
  if (state["protocol_version"] !== HOST_STATE_PROTOCOL_VERSION) return null;
  const workers = state["workers"];
  if (!Array.isArray(workers)) return null;
  return { workers: workers.length };
}

/**
 * The same, from the JSON text the daemon printed. PURE.
 *
 * Text that is not JSON is a daemon that answered with something else — an
 * error line, a truncated write, a stub on a machine where the bundle was
 * never built. All of it means the same thing here, and none of it is worth
 * an exception the caller would have to catch to keep its address.
 */
export function parseHostState(text: string | null | undefined): HostState | null {
  if (text == null || text.trim() === "") return null;
  try {
    return hostStateFrom(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Produces the host-state document as text, or null when there is none. */
export type HostStateSource = () => Promise<string | null>;

export type HostStateCommand = (
  argv: string[],
  options?: BoundedCommandOptions,
) => Promise<BoundedCommandResult>;

function latestResidentBundle(dir: string): string | null {
  try {
    const name = readdirSync(dir)
      .filter((entry) => /^redskilled-.*\.bundle\.min\.mjs$/.test(entry))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    return name ? `${dir}/${name}` : null;
  } catch {
    return null;
  }
}

/** Resolve the daemon-compatible client, preferring its resident bundle. */
export function resolveRedskilledBin(home = homedir()): string | null {
  const root = home.replace(/\\/g, "/");
  const resident = latestResidentBundle(`${root}/.red/redskilled/bundles`);
  if (resident) return resident;
  const cached = latestResidentBundle(`${root}/.cache/red-skills/bundles`);
  if (cached) return cached;
  const packaged = `${root}/.red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs`;
  return existsSync(packaged) ? packaged : null;
}

/** Derive the resident socket without creating its directory or starting a daemon. */
export function resolveRedskilledSocket(
  env: NodeJS.ProcessEnv = process.env,
  uid: number | string = process.getuid?.() ?? "nouid",
): string | null {
  if (process.platform === "win32") return null;
  const sessionKey = env["REDSKILLED_SESSION"]?.trim() ||
    env["XDG_RUNTIME_DIR"]?.trim() || `uid:${uid}`;
  const hash = createHash("sha256").update(`redskilled:${sessionKey}`).digest("hex").slice(0, 20);
  const socketName = "redskilled.sock";
  const xdg = env["XDG_RUNTIME_DIR"]?.trim();
  if (xdg) {
    const path = join(xdg, "red-skills", hash, socketName);
    if (path.length < 108) return path;
  }
  const candidate = join(tmpdir(), `red-skills-${uid}`, hash, socketName);
  return candidate.length < 108 ? candidate : join("/tmp", `red-skills-${uid}`, hash, socketName);
}

/** Read host-state over the existing socket. This function has no birth path. */
export async function readHostInventoryNoStart(
  socketPath = resolveRedskilledSocket(),
  timeoutMs = 500,
): Promise<HostInventory | null> {
  if (!socketPath || !existsSync(socketPath)) return null;
  return await new Promise((resolve) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const finish = (value: HostInventory | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: `red-dev-${process.pid}`, op: "host-state" })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.length > 10 * 1024 * 1024) return finish(null);
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.slice(0, newline)) as {
          ok?: unknown;
          value?: unknown;
        };
        finish(response.ok === true ? hostInventoryFrom(response.value) : null);
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
    socket.on("close", () => finish(null));
  });
}

/**
 * Ask for host-state and reduce it, or answer null.
 *
 * The source is injected so the two cases that matter — a daemon that is not
 * running and a daemon whose document this build cannot read — are testable
 * without a machine in either state. A source that rejects is caught here
 * rather than at the caller, because "the command is not installed" is the
 * ordinary condition on a machine that only ever wanted the wallpaper, and
 * an ordinary condition must not travel as an exception.
 */
export async function readHostState(
  source: HostStateSource = askRedskilled,
  timeoutMs = 2_000,
): Promise<HostState | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timed = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const text = await Promise.race([source(), timed]);
    return parseHostState(text);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const WSL_HOST_STATE_PROGRAM = [
  'b=$(ls -1 "$HOME"/.red/redskilled/bundles/redskilled-*.bundle.min.mjs "$HOME"/.cache/red-skills/bundles/redskilled-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1)',
  '[ -n "$b" ] || b="$HOME/.red-skills/current/packaging/npm/bin/red-skills-redskilled.mjs"',
  '[ -f "$b" ] || exit 3',
  'n=$(command -v node 2>/dev/null || ls -1 /usr/local/bin/node /usr/bin/node "$HOME"/.local/share/mise/installs/node/*/bin/node "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node "$HOME"/.nodenv/shims/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node 2>/dev/null | sort -V | tail -1)',
  '[ -n "$n" ] || exit 3',
  'exec "$n" "$b" host-state',
].join("; ");

// wsl.exe reconstructs a command line while crossing the Windows/Linux
// boundary. A literal shell program containing `$()` and globs can therefore
// be expanded once too early when red-dev itself runs under WSL. Base64 keeps
// the program inert until the shell inside the selected distro decodes it.
const WSL_HOST_STATE_SCRIPT =
  `printf %s ${Buffer.from(WSL_HOST_STATE_PROGRAM).toString("base64")} | base64 -d | sh`;

/**
 * Read every already-running WSL RedSkills host from native Windows.
 *
 * The inventory call comes first so a cosmetic refresh never knowingly
 * starts a stopped distro. Inside each running distro the resident
 * `redskilled host-state` client contacts the existing socket only; it has no
 * daemon birth path. Non-RedSkills distros (Docker's internal distro is the
 * common one) contribute nothing rather than withholding a real count from a
 * participating Ubuntu or Debian host.
 */
export async function readWindowsWslHostState(
  run: HostStateCommand = runBounded,
): Promise<HostState | null> {
  const wsl = Bun.which("wsl.exe");
  if (!wsl && run === runBounded) return null;

  const running = await run([wsl ?? "wsl.exe", "--list", "--running", "--quiet"], {
    timeoutMs: 2_000,
  });
  if (running.timedOut || running.exitCode !== 0) return null;
  const distros = running.stdout
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((name) => name.trim().replace(/^\*\s*/, ""))
    .filter(Boolean);
  if (distros.length === 0) return null;

  const states = await Promise.all(
    distros.map(async (distro): Promise<HostState | null> => {
      const result = await run(
        [wsl ?? "wsl.exe", "-d", distro, "--", "sh", "-lc", WSL_HOST_STATE_SCRIPT],
        { timeoutMs: 2_000 },
      );
      return result.timedOut || result.exitCode !== 0 ? null : parseHostState(result.stdout);
    }),
  );
  const known = states.filter((state): state is HostState => state !== null);
  return known.length === 0
    ? null
    : { workers: known.reduce((total, state) => total + state.workers, 0) };
}

/**
 * The default source: the already-running redskilled socket.
 *
 * A read and only a read. It never invokes the auto-spawning RedSkills client,
 * which is the property that lets a wallpaper regenerate
 * without a cosmetic feature becoming what births a machine-wide singleton.
 *
 * A checkout that is absent, or present without its built bundle, exits
 * non-zero or prints nothing — and both arrive here as null, which is the
 * same answer a stopped daemon gives. That is deliberate: red-dev has no
 * repair to offer for either, and the Redwall it draws is identical.
 */
async function askRedskilled(): Promise<string | null> {
  const inventory = await readHostInventoryNoStart();
  return inventory
    ? JSON.stringify({
      version: HOST_STATE_VERSION,
      protocol_version: HOST_STATE_PROTOCOL_VERSION,
      pid: inventory.daemonPid,
      workers: inventory.workers,
    })
    : null;
}
