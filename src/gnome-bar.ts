/**
 * The persistent Ubuntu surface: RedDB's entry point in GNOME's own panel.
 *
 * Omarchy can draw an entire shell because it owns Hyprland and Quickshell.
 * red-dev runs on stock Ubuntu, where GNOME Shell already owns the clock,
 * network, audio, battery and AppIndicator tray. Extending that panel keeps
 * those working and adds the missing RedDB menu, workspaces and agent entry.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

import metadata from "../config/gnome/reddb-bar/metadata.gnome" with { type: "text" };
import extension from "../config/gnome/reddb-bar/extension.gnome" with { type: "text" };
import stylesheet from "../config/gnome/reddb-bar/stylesheet.gnome" with { type: "text" };
import icon from "../config/gnome/reddb-bar/reddb-icon.gnome" with { type: "text" };

export const GNOME_BAR_UUID = "reddb-bar@reddb.io";

export const GNOME_BAR_FILES: Readonly<Record<string, string>> = {
  "metadata.json": metadata,
  "extension.js": extension,
  "stylesheet.css": stylesheet,
  "reddb-icon.svg": icon,
};

function home(): string {
  const value = process.env["HOME"];
  if (!value) throw new RedError("HOME is not set — cannot install the GNOME menu bar");
  return value;
}

export function gnomeBarDir(homeDir = home()): string {
  return join(homeDir, ".local", "share", "gnome-shell", "extensions", GNOME_BAR_UUID);
}

async function gnomeExtensions(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const binary = Bun.which("gnome-extensions");
  if (!binary) return { code: 127, out: "", err: "gnome-extensions is not installed" };
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

async function settings(...args: string[]): Promise<{ code: number; out: string; err: string }> {
  const binary = Bun.which("gsettings");
  if (!binary) return { code: 127, out: "", err: "gsettings is not installed" };
  const child = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out, err };
}

function stringArray(value: string): string[] {
  return [...value.matchAll(/['"]([^'"]+)['"]/g)].map(match => match[1] ?? "");
}

async function selectExtension(enabled: boolean): Promise<void> {
  const current = await settings("get", "org.gnome.shell", "enabled-extensions");
  if (current.code !== 0) throw new RedError(current.err.trim() || "could not read GNOME extensions");
  const values = stringArray(current.out).filter(value => value !== GNOME_BAR_UUID);
  if (enabled) values.push(GNOME_BAR_UUID);
  const literal = `[${values.map(value => `'${value.replaceAll("'", "\\'")}'`).join(", ")}]`;
  const write = await settings("set", "org.gnome.shell", "enabled-extensions", literal);
  if (write.code !== 0) throw new RedError(write.err.trim() || "could not update GNOME extensions");
  if (enabled) {
    const users = await settings("set", "org.gnome.shell", "disable-user-extensions", "false");
    if (users.code !== 0) throw new RedError(users.err.trim() || "could not enable GNOME user extensions");
  }
}

async function writeIfChanged(path: string, body: string): Promise<boolean> {
  if (existsSync(path) && await Bun.file(path).text() === body) return false;
  await Bun.write(path, body);
  return true;
}

export async function convergeGnomeBar(p: Platform): Promise<void> {
  if (p.env !== "desktop" || p.os !== "linux") {
    log.skip("GNOME menu bar applies only to the Ubuntu desktop");
    return;
  }

  if (!Bun.which("gnome-extensions")) {
    throw new RedError("gnome-extensions is absent — the Ubuntu desktop cannot register the RedDB menu bar");
  }

  const before = await gnomeExtensions("info", GNOME_BAR_UUID);
  const wasEnabled = before.code === 0 && /^State:\s+ENABLED$/m.test(before.out);
  const dir = gnomeBarDir();
  mkdirSync(dir, { recursive: true });

  let changed = 0;
  for (const [name, body] of Object.entries(GNOME_BAR_FILES)) {
    if (await writeIfChanged(join(dir, name), body)) changed++;
  }

  await selectExtension(true);
  if (wasEnabled && changed > 0) await gnomeExtensions("disable", GNOME_BAR_UUID);
  const known = await gnomeExtensions("info", GNOME_BAR_UUID);
  let active = false;
  if (known.code === 0) {
    const enabled = await gnomeExtensions("enable", GNOME_BAR_UUID);
    if (enabled.code !== 0) throw new RedError(enabled.err.trim() || "GNOME could not enable the RedDB menu bar");
    active = true;
  } else {
    log.info("GNOME will load the new RedDB menu bar at the next sign-in");
  }

  if (changed > 0) log.ok(`GNOME menu bar: ${changed} file(s) written and ${active ? "enabled" : "selected"}`);
  else log.skip(`GNOME menu bar already current and ${active ? "enabled" : "selected"}`);
}

export async function removeGnomeBar(p: Platform): Promise<string[]> {
  if (p.env !== "desktop" || p.os !== "linux") return [];
  const dir = gnomeBarDir();
  if (!existsSync(dir)) return [];
  await gnomeExtensions("disable", GNOME_BAR_UUID);
  await selectExtension(false);
  await Bun.$`rm -rf ${dir}`.quiet().nothrow();
  return [dir];
}
