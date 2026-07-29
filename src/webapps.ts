/**
 * Web apps: a browser page that behaves like an installed application.
 *
 * omakub's `web2app` writes a .desktop entry launching Chromium with
 * `--app=<url>`, which drops the tab strip and address bar and gives the
 * page its own window, icon and alt-tab entry. Same idea here.
 *
 * Desktop-only by construction rather than by omission. A .desktop file
 * needs a freedesktop menu to appear in, so under WSL it would write a
 * file nothing reads, and on native Windows the equivalent is a
 * different mechanism entirely (a shortcut with its own arguments).
 * Both are reported as skips with the reason rather than silently doing
 * nothing.
 */

import { existsSync, mkdirSync } from "node:fs";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

export interface WebApp {
  name: string;
  url: string;
  /** PNG icon, fetched once into the user's icon directory. */
  icon: string;
}

/**
 * Kept short on purpose. omakub offers four; a list of thirty would be
 * a directory, and the point is a handful of pages you actually keep
 * open all day.
 */
export const WEB_APPS: WebApp[] = [
  {
    name: "ChatGPT",
    url: "https://chatgpt.com/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/chatgpt.png",
  },
  {
    name: "Claude",
    url: "https://claude.ai/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/anthropic.png",
  },
  {
    name: "Google Photos",
    url: "https://photos.google.com/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/google-photos.png",
  },
  {
    name: "Google Contacts",
    url: "https://contacts.google.com/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/google-contacts.png",
  },
  {
    name: "Tailscale",
    url: "https://login.tailscale.com/admin/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/tailscale-light.png",
  },
  {
    name: "GitHub",
    url: "https://github.com/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/github.png",
  },
];

/**
 * A Chromium-family browser, which is what `--app=` requires. Firefox
 * has no equivalent that produces a chromeless window, so a machine
 * with only Firefox gets a clear refusal rather than a broken launcher.
 */
function findBrowser(): string | null {
  for (const bin of ["google-chrome", "chromium", "chromium-browser", "brave-browser", "microsoft-edge"]) {
    if (Bun.which(bin)) return bin;
  }
  return null;
}

function home(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new RedError("neither HOME nor USERPROFILE is set");
  return h;
}

export function webAppsSupported(p: Platform): { ok: boolean; reason: string } {
  if (p.os === "windows") {
    return { ok: false, reason: "native Windows uses shortcuts, not .desktop entries" };
  }
  if (!p.caps.gui) {
    return { ok: false, reason: "no desktop session to show a launcher in" };
  }
  if (!findBrowser()) {
    return { ok: false, reason: "no Chromium-family browser; --app= has no Firefox equivalent" };
  }
  return { ok: true, reason: "" };
}

export async function installWebApp(app: WebApp): Promise<void> {
  const browser = findBrowser();
  if (!browser) throw new RedError("no Chromium-family browser found");

  const iconDir = `${home()}/.local/share/applications/icons`;
  const appDir = `${home()}/.local/share/applications`;
  mkdirSync(iconDir, { recursive: true });
  mkdirSync(appDir, { recursive: true });

  const slug = app.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const iconPath = `${iconDir}/${slug}.png`;

  if (!existsSync(iconPath)) {
    const res = await fetch(app.icon);
    if (!res.ok) throw new RedError(`icon download failed ${res.status}: ${app.icon}`);
    await Bun.write(iconPath, res);
  }

  // --app= is what removes the tab strip; the class makes the window
  // group under its own icon rather than the browser's.
  const entry = `[Desktop Entry]
Version=1.0
Name=${app.name}
Comment=${app.name}
Exec=${browser} --app="${app.url}" --name="${app.name}" --class="${app.name}"
Terminal=false
Type=Application
Icon=${iconPath}
Categories=GTK;WebApps;
MimeType=text/html;text/xml;application/xhtml_xml;
StartupWMClass=${app.name}
StartupNotify=true
`;

  await Bun.write(`${appDir}/${slug}.desktop`, entry);
  log.ok(`${app.name} — ${app.url}`);
}

export function installedWebApps(): string[] {
  const appDir = `${home()}/.local/share/applications`;
  if (!existsSync(appDir)) return [];
  return WEB_APPS.filter((a) =>
    existsSync(`${appDir}/${a.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.desktop`),
  ).map((a) => a.name);
}

export async function removeWebApp(name: string): Promise<void> {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const appDir = `${home()}/.local/share/applications`;
  for (const path of [`${appDir}/${slug}.desktop`, `${appDir}/icons/${slug}.png`]) {
    if (existsSync(path)) {
      await Bun.spawn(["rm", "-f", path], { stdout: "ignore", stderr: "ignore" }).exited;
    }
  }
}
