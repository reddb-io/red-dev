/** Narrow desktop convergence, safe inside mise's tool postinstall lock. */
import type { DriftCheck } from "./drift.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

export interface DesktopCheck extends DriftCheck {
  /** Files are ready; a new/available graphical session is still needed. */
  deferred?: boolean;
}

export interface DesktopDeps {
  declareMise: (p: Platform) => void | Promise<void>;
  bar: (p: Platform) => Promise<unknown>;
  keys: (p: Platform) => Promise<void>;
  inspect: (p: Platform) => Promise<DesktopCheck[]>;
  session?: () => Promise<"available" | "absent" | "unknown">;
  postinstall?: boolean;
}

export async function inspectDesktop(p: Platform): Promise<DesktopCheck[]> {
  if (p.os !== "linux" || p.env !== "desktop") return [];
  const [{ inspectGnomeBar, gnomeBarDrift, gnomeBarActorDrift }, { inspectGnomeKeys }] = await Promise.all([
    import("./gnome-bar.ts"), import("./gnome-keys.ts"),
  ]);
  const [bar, keys] = await Promise.all([inspectGnomeBar(p), inspectGnomeKeys(p)]);
  const deferred = bar.filesCurrent && bar.selected === true && bar.userExtensionsEnabled === true &&
    (bar.state === "pending-login" || bar.state === "unavailable");
  return [{ ...gnomeBarDrift(bar), deferred }, ...gnomeBarActorDrift(bar), keys];
}

async function defaultDeps(): Promise<DesktopDeps> {
  const [{ convergeMiseConfig }, { convergeGnomeBar }, { installGnomeKeys }, { inspectGnomeSession }] = await Promise.all([
    import("./mise-config.ts"), import("./gnome-bar.ts"), import("./gnome-keys.ts"), import("./gnome-session.ts"),
  ]);
  return {
    // Writes the owned fragment only: no install/upgrade, no nested mise lock.
    declareMise: (p) => { convergeMiseConfig(p); },
    bar: convergeGnomeBar,
    keys: installGnomeKeys,
    inspect: inspectDesktop,
    session: inspectGnomeSession,
    postinstall: process.env["MISE_TOOL_NAME"] === "red-dev" && !!process.env["MISE_TOOL_INSTALL_PATH"],
  };
}

export async function desktopCommand(
  p: Platform,
  verb: "status" | "reconcile" = "status",
  injected?: DesktopDeps,
): Promise<number> {
  if (p.os !== "linux" || p.env !== "desktop") {
    log.skip("desktop: GNOME menu reconciliation applies only to the Linux desktop");
    return 0;
  }
  const deps = injected ?? await defaultDeps();
  let failures = 0;
  if (verb === "reconcile") {
    try { await deps.declareMise(p); }
    catch (error) {
      log.err(`mise declaration: ${error instanceof Error ? error.message : String(error)}`);
      failures++;
    }
    // SSH / a pre-login upgrade can install the CLI without owning a Shell
    // session. Do not treat that as a package failure, or claim the desktop
    // was repaired. Unknown/permission errors still take the normal fail path.
    if (deps.session && await deps.session() === "absent") {
      log.warn("desktop reconciliation deferred — no signed-in GNOME Shell session");
      log.plain("       after signing in, run: red-dev desktop reconcile");
      return failures > 0 ? 1 : deps.postinstall ? 0 : 2;
    }
    // Independent repairs: a refused extension must not prevent shortcut repair.
    for (const [name, apply] of [
      ["GNOME menu", deps.bar],
      ["GNOME shortcuts", deps.keys],
    ] as const) {
      try { await apply(p); }
      catch (error) {
        log.err(`${name}: ${error instanceof Error ? error.message : String(error)}`);
        failures++;
      }
    }
  }
  const checks = await deps.inspect(p);
  for (const row of checks) {
    const detail = `${row.name} — ${row.detail}`;
    if (row.status === "ok") log.ok(detail);
    else if (row.status === "n/a") log.skip(detail);
    else log.warn(detail);
    if (row.fix) log.plain(`       fix: ${row.fix}`);
  }
  if (failures > 0) return 1;
  // A pending login is not an installation failure to retry inside mise.
  // Inspection remains nonzero until the new runtime really is loaded.
  if (checks.some(row => row.status === "drift" && !(verb === "reconcile" && row.deferred))) return 2;
  return 0;
}
