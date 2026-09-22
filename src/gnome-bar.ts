/**
 * The persistent Ubuntu surface: RedDB's entry point in GNOME's own panel.
 *
 * Omarchy can draw an entire shell because it owns Hyprland and Quickshell.
 * red-dev runs on stock Ubuntu, where GNOME Shell already owns the clock,
 * network, audio, battery and AppIndicator tray. Extending that panel keeps
 * those working and adds the missing RedDB menu, workspaces and agent entry.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DriftCheck } from "./drift.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

import metadata from "../config/gnome/reddb-bar/metadata.gnome" with { type: "text" };
import extension from "../config/gnome/reddb-bar/extension.gnome" with { type: "text" };
import stylesheet from "../config/gnome/reddb-bar/stylesheet.gnome" with { type: "text" };
import icon from "../config/gnome/reddb-bar/reddb-icon.gnome" with { type: "text" };

export const GNOME_BAR_UUID = "reddb-bar@reddb.io";

const SOURCE_FILES: Readonly<Record<string, string>> = {
  "metadata.json": metadata,
  "extension.js": extension,
  "stylesheet.css": stylesheet,
  "reddb-icon.svg": icon,
};

/** Identity of the code loaded by Shell, not merely the files on disk. */
export const GNOME_BAR_REVISION = createHash("sha256").update(JSON.stringify(SOURCE_FILES)).digest("hex");
export const GNOME_BAR_FILES: Readonly<Record<string, string>> = {
  ...SOURCE_FILES,
  "extension.js": extension.replaceAll("__RED_DEV_BAR_REVISION__", GNOME_BAR_REVISION),
};

export interface GnomeBarResult { code: number; out: string; err: string }
export type GnomeBarRunner = (argv: readonly string[]) => Promise<GnomeBarResult>;
export interface GnomeBarOptions {
  homeDir?: string;
  run?: GnomeBarRunner;
  quiet?: boolean;
}

export type GnomeBarState = "not-applicable" | "missing" | "outdated" | "disabled" | "error" | "pending-login" | "unavailable" | "active";
export interface GnomeBarStatus {
  applies: boolean;
  installed: boolean;
  filesCurrent: boolean;
  selected: boolean | null;
  userExtensionsEnabled: boolean | null;
  /** GNOME's numeric ExtensionState: 1 ACTIVE, 2 INACTIVE, 3 ERROR, 4 OUT_OF_DATE. */
  shellState: number | null;
  active: boolean;
  expectedRevision: string;
  runtimeRevision: string | null;
  /** Read-only actor observations, not screenshot/visual confirmation. */
  runtime: Record<string, unknown> | null;
  state: GnomeBarState;
  detail: string;
  fix?: string;
}

export interface GnomeBarReport {
  changedFiles: string[];
  status: GnomeBarStatus;
}

const SHELL = ["busctl", "--user", "--json=short", "--timeout=3", "call", "org.gnome.Shell", "/org/gnome/Shell", "org.gnome.Shell.Extensions"] as const;
const RUNTIME = ["busctl", "--user", "--json=short", "--timeout=3", "call", "org.gnome.Shell", "/io/reddb/RedDevDesktop", "io.reddb.RedDevDesktop", "Get"] as const;

/** Every session probe is bounded, including a stuck gsettings process. */
const runCommand: GnomeBarRunner = async (argv) => {
  const binary = argv[0] && Bun.which(argv[0]);
  if (!binary) return { code: 127, out: "", err: `${argv[0]} is not installed` };
  try {
    const child = Bun.spawn([binary, ...argv.slice(1)], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let expired = false;
    const timer = setTimeout(() => { expired = true; child.kill("SIGKILL"); }, 4_000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      return { code: expired ? 124 : code, out, err: expired ? `${argv[0]} timed out` : err };
    } finally { clearTimeout(timer); }
  } catch (error) {
    return { code: 1, out: "", err: String(error) };
  }
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** busctl JSON avoids translated human-facing `gnome-extensions info` text. */
export function parseGnomeExtensionInfo(out: string): { state: number | null; error: string; known: boolean } | null {
  try {
    const message: unknown = JSON.parse(out);
    if (!record(message) || message.type !== "a{sv}" || !Array.isArray(message.data) || !record(message.data[0])) return null;
    const info = message.data[0];
    const state = record(info.state) && typeof info.state.data === "number" ? info.state.data : null;
    const error = record(info.error) && typeof info.error.data === "string" ? info.error.data : "";
    return { state, error, known: Object.keys(info).length > 0 };
  } catch { return null; }
}

function parseRuntime(out: string): Record<string, unknown> | null {
  try {
    const message: unknown = JSON.parse(out);
    if (!record(message) || message.type !== "s" || !Array.isArray(message.data) || typeof message.data[0] !== "string") return null;
    const runtime: unknown = JSON.parse(message.data[0]);
    return record(runtime) && typeof runtime.revision === "string" ? runtime : null;
  } catch { return null; }
}

function home(): string {
  const value = process.env["HOME"];
  if (!value) throw new RedError("HOME is not set — cannot install the GNOME menu bar");
  return value;
}

export function gnomeBarDir(homeDir = home()): string {
  return join(homeDir, ".local", "share", "gnome-shell", "extensions", GNOME_BAR_UUID);
}

function stringArray(value: string): string[] {
  return [...value.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1] ?? "");
}

async function selectExtension(enabled: boolean, run = runCommand): Promise<void> {
  const current = await run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"]);
  if (current.code !== 0) throw new RedError(current.err.trim() || "could not read GNOME extensions");
  const values = stringArray(current.out).filter(value => value !== GNOME_BAR_UUID);
  if (enabled) values.push(GNOME_BAR_UUID);
  const literal = `[${values.map(value => `'${value.replaceAll("'", "\\'")}'`).join(", ")}]`;
  if (stringArray(current.out).includes(GNOME_BAR_UUID) !== enabled) {
    const write = await run(["gsettings", "set", "org.gnome.shell", "enabled-extensions", literal]);
    if (write.code !== 0) throw new RedError(write.err.trim() || "could not update GNOME extensions");
  }
  if (enabled) {
    const currentUsers = await run(["gsettings", "get", "org.gnome.shell", "disable-user-extensions"]);
    if (currentUsers.code !== 0) throw new RedError(currentUsers.err.trim() || "could not read GNOME user extensions");
    if (currentUsers.out.trim() !== "false") {
      const users = await run(["gsettings", "set", "org.gnome.shell", "disable-user-extensions", "false"]);
      if (users.code !== 0) throw new RedError(users.err.trim() || "could not enable GNOME user extensions");
    }
  }
}

async function writeIfChanged(path: string, body: string): Promise<boolean> {
  if (existsSync(path) && await Bun.file(path).text() === body) return false;
  await Bun.write(path, body);
  return true;
}

export async function inspectGnomeBar(p: Platform, options: GnomeBarOptions = {}): Promise<GnomeBarStatus> {
  const applies = p.env === "desktop" && p.os === "linux";
  const status: GnomeBarStatus = {
    applies, installed: false, filesCurrent: false, selected: null, userExtensionsEnabled: null,
    shellState: null, active: false, expectedRevision: GNOME_BAR_REVISION, runtimeRevision: null, runtime: null,
    state: "not-applicable", detail: "GNOME menu bar applies only to the Ubuntu desktop",
  };
  if (!applies) return status;
  const dir = gnomeBarDir(options.homeDir);
  status.installed = existsSync(join(dir, "metadata.json"));
  status.filesCurrent = (await Promise.all(Object.entries(GNOME_BAR_FILES).map(async ([name, body]) => {
    try { return await Bun.file(join(dir, name)).text() === body; } catch { return false; }
  }))).every(Boolean);
  const run = options.run ?? runCommand;
  const [infoResult, selected, users, runtimeResult] = await Promise.all([
    run([...SHELL, "GetExtensionInfo", "s", GNOME_BAR_UUID]),
    run(["gsettings", "get", "org.gnome.shell", "enabled-extensions"]),
    run(["gsettings", "get", "org.gnome.shell", "disable-user-extensions"]),
    run(RUNTIME),
  ]);
  const info = infoResult.code === 0 ? parseGnomeExtensionInfo(infoResult.out) : null;
  status.shellState = info?.state ?? null;
  status.active = status.shellState === 1;
  status.selected = selected.code === 0 ? stringArray(selected.out).includes(GNOME_BAR_UUID) : null;
  status.userExtensionsEnabled = users.code === 0 && /^(true|false)$/.test(users.out.trim()) ? users.out.trim() === "false" : null;
  status.runtime = runtimeResult.code === 0 ? parseRuntime(runtimeResult.out) : null;
  status.runtimeRevision = typeof status.runtime?.revision === "string" ? status.runtime.revision : null;
  status.fix = "red-dev desktop reconcile";
  if (!status.installed) {
    status.state = "missing"; status.detail = "GNOME menu bar is not installed";
  } else if (!status.filesCurrent) {
    status.state = "outdated"; status.detail = "GNOME menu bar files differ from this red-dev version";
  } else if (status.selected === false || status.userExtensionsEnabled === false) {
    status.state = "disabled"; status.detail = "GNOME menu bar is installed but disabled in GNOME settings";
  } else if (status.shellState === 3 || status.shellState === 4) {
    status.state = "error"; status.detail = `GNOME menu bar failed to load${info?.error ? `: ${info.error}` : ` (Shell state ${status.shellState})`}`;
    status.fix = "sign out and back in; then: red-dev desktop status";
  } else if (status.active && status.runtimeRevision === GNOME_BAR_REVISION && status.selected === true && status.userExtensionsEnabled === true) {
    status.state = "active"; status.detail = "GNOME menu bar is installed and running the current revision; visual appearance is not verified";
    delete status.fix;
  } else if (!info || status.selected === null || status.userExtensionsEnabled === null) {
    status.state = "unavailable"; status.detail = "GNOME menu bar files are current; the desktop session could not be verified";
    status.fix = "run red-dev desktop status inside the signed-in GNOME session";
  } else if (status.shellState === 2 || status.shellState === 6) {
    status.state = "disabled"; status.detail = "GNOME menu bar is selected but inactive in the current session";
  } else {
    status.state = "pending-login";
    status.detail = status.active
      ? "GNOME menu bar is active, but the current revision is not loaded or cannot be identified; sign out and back in"
      : "GNOME menu bar is installed and selected; sign out and back in to load it";
    status.fix = "sign out and back in; then: red-dev desktop status";
  }
  return status;
}

/** This reports the runtime separately from installation, including to doctor. */
export function gnomeBarDrift(status: GnomeBarStatus): DriftCheck {
  return {
    name: "GNOME menu bar", status: status.state === "not-applicable" ? "n/a" : status.state === "active" ? "ok" : "drift",
    detail: status.detail, ...(status.fix ? { fix: status.fix } : {}),
  };
}

function mappedActor(value: unknown): boolean {
  return record(value) && value.visible === true && value.mapped === true
    && typeof value.width === "number" && value.width > 0
    && typeof value.height === "number" && value.height > 0;
}

/**
 * These are observations made inside Shell, not labels merely advertised
 * on StatusNotifier D-Bus. A mapped actor is still not a screenshot: its
 * colour, clipping and perceptual appearance are deliberately not claimed.
 */
export function gnomeBarActorDrift(status: GnomeBarStatus): DriftCheck[] {
  // The lifecycle check already explains why old/missing runtime evidence
  // is inconclusive. Do not repeat that as three invented actor failures.
  if (status.state !== "active" || !status.runtime) return [];
  const fix = "red-dev desktop reconcile; if unchanged, sign out and back in";
  const checks: DriftCheck[] = [mappedActor(status.runtime.menu)
    ? { name: "GNOME menu actor", status: "ok", detail: "menu actor is mapped with nonzero size; visual appearance is not verified" }
    : { name: "GNOME menu actor", status: "drift", detail: "current bar runtime does not report a mapped, visible menu actor with nonzero size", fix }];
  const indicators = Array.isArray(status.runtime.indicators) ? status.runtime.indicators : [];
  for (const name of ["RedRouter", "Redskilled"]) {
    const item: unknown = indicators.find(value => record(value) && value.name === name);
    if (record(item) && item.registered === false) {
      checks.push({ name: `${name} tray label`, status: "n/a", detail: "no matching AppIndicator actor is registered in this Shell session; service state is not inferred" });
      continue;
    }
    if (!record(item) || item.registered !== true || !Array.isArray(item.actors) || item.actors.length === 0) {
      checks.push({ name: `${name} tray label`, status: "drift", detail: "current bar runtime has no conclusive label actor observation", fix });
      continue;
    }
    const mapped = item.actors.every(actor => record(actor) && mappedActor(actor.indicator)
      && record(actor.label) && actor.label.text === name && mappedActor(actor.label));
    checks.push(mapped
      ? { name: `${name} tray label`, status: "ok", detail: `"${name}" label actor is mapped with nonzero size; visual appearance is not verified` }
      : { name: `${name} tray label`, status: "drift", detail: `registered indicator does not report a mapped, visible "${name}" label with nonzero size`, fix });
  }
  return checks;
}

export async function convergeGnomeBar(p: Platform, options: GnomeBarOptions = {}): Promise<GnomeBarReport> {
  if (p.env !== "desktop" || p.os !== "linux") {
    const status = await inspectGnomeBar(p, options);
    if (!options.quiet) log.skip(status.detail);
    return { changedFiles: [], status };
  }
  const run = options.run ?? runCommand;
  const dir = gnomeBarDir(options.homeDir);
  mkdirSync(dir, { recursive: true });
  const changedFiles: string[] = [];
  for (const [name, body] of Object.entries(GNOME_BAR_FILES)) {
    if (await writeIfChanged(join(dir, name), body)) changedFiles.push(name);
  }
  await selectExtension(true, run);
  let status = await inspectGnomeBar(p, options);
  // Disabling/re-enabling cannot prove that GNOME discarded its cached ES
  // module. Leave an active extension alone; only a runtime revision can
  // show that the new code actually loaded.
  if (status.shellState === 2 || status.shellState === 6) {
    const enabled = await run([...SHELL, "EnableExtension", "s", GNOME_BAR_UUID]);
    if (enabled.code !== 0) throw new RedError(enabled.err.trim() || "GNOME could not enable the RedDB menu bar");
    for (let attempt = 0; attempt < 3; attempt++) {
      status = await inspectGnomeBar(p, options);
      if (status.active || status.state === "error") break;
      if (attempt < 2) await Bun.sleep(80);
    }
    if (!status.active && status.state !== "unavailable") {
      throw new RedError(status.state === "error" ? status.detail : "GNOME accepted enable but the menu bar did not become active");
    }
  }
  if (["error", "disabled", "missing", "outdated"].includes(status.state)) throw new RedError(status.detail);
  if (!options.quiet) {
    if (changedFiles.length > 0) log.ok(`GNOME menu bar: ${changedFiles.length} file(s) written`);
    if (status.state === "active") log.ok(status.detail);
    else log.info(status.detail);
  }
  return { changedFiles, status };
}

export async function removeGnomeBar(p: Platform): Promise<string[]> {
  if (p.env !== "desktop" || p.os !== "linux") return [];
  const dir = gnomeBarDir();
  if (!existsSync(dir)) return [];
  await runCommand([...SHELL, "DisableExtension", "s", GNOME_BAR_UUID]);
  await selectExtension(false);
  await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  return [dir];
}
