/** Whether a GNOME session is present, independently of any extension state. */
import { statSync } from "node:fs";
import { join } from "node:path";

export type GnomeSessionState = "available" | "absent" | "unknown";
export interface GnomeSessionResult { code: number; out: string; err: string }
export type GnomeSessionRunner = (argv: readonly string[]) => Promise<GnomeSessionResult>;
export interface GnomeSessionOptions {
  run?: GnomeSessionRunner;
  /** Environment and socket observations are injectable for fixture tests. */
  env?: NodeJS.ProcessEnv;
  userBusSocket?: boolean | null;
}

const SESSION_PROBE = [
  "busctl", "--user", "--json=short", "--timeout=3", "call",
  "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus",
  "NameHasOwner", "s", "org.gnome.Shell",
] as const;

function hasUserBusSocket(env: NodeJS.ProcessEnv): boolean | null {
  const runtime = env["XDG_RUNTIME_DIR"] || (process.getuid ? `/run/user/${process.getuid()}` : null);
  if (!runtime) return null;
  try {
    return statSync(join(runtime, "bus")).isSocket();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // An unreadable path is uncertainty, not proof that no session exists.
    return code === "ENOENT" || code === "ENOTDIR" ? false : null;
  }
}

const runProbe: GnomeSessionRunner = async argv => {
  try {
    const child = Bun.spawn([...argv], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let expired = false;
    const timeout = setTimeout(() => {
      expired = true;
      child.kill("SIGKILL");
    }, 4_000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code: expired ? 124 : code, out, err };
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return { code: 127, out: "", err: "session probe unavailable" };
  }
};

/**
 * Only positive evidence of absence may defer a desktop postinstall. A denied,
 * timed-out or malformed probe must remain unknown rather than hide a failure.
 */
export async function inspectGnomeSession(options: GnomeSessionOptions = {}): Promise<GnomeSessionState> {
  const env = options.env ?? process.env;
  const socket = options.userBusSocket === undefined ? hasUserBusSocket(env) : options.userBusSocket;
  if (!env["DBUS_SESSION_BUS_ADDRESS"]?.trim() && socket === false) return "absent";

  try {
    const result = await (options.run ?? runProbe)(SESSION_PROBE);
    if (result.code !== 0) return "unknown";
    const value: unknown = JSON.parse(result.out);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return "unknown";
    const message = value as Record<string, unknown>;
    if (message.type !== "b" || !Array.isArray(message.data) || message.data.length !== 1 || typeof message.data[0] !== "boolean") {
      return "unknown";
    }
    return message.data[0] ? "available" : "absent";
  } catch {
    return "unknown";
  }
}
