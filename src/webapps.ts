/**
 * Web apps: a browser page that behaves like an installed application.
 *
 * omakub's `web2app` writes a .desktop entry launching Chromium with
 * `--app=<url>`, which drops the tab strip and address bar and gives the
 * page its own window, icon and alt-tab entry. Same idea here, with the
 * shell function's two limits removed: it is Linux-only, and it
 * hard-codes `google-chrome` on a machine that may not have it.
 *
 * ## Three targets, two mechanisms, one skip
 *
 * A Linux desktop gets the freedesktop entry, with the icon fetched once
 * into the user's icon directory. Native Windows has no such thing: the
 * equivalent is a Start Menu shortcut whose arguments carry the same
 * `--app=` the entry's Exec line does. WSL gets neither — it has no
 * freedesktop menu of its own, and a .desktop file written there is read
 * by nothing, so it is reported as a skip with that reason rather than
 * written and silently ignored.
 *
 * ## What the entry says about itself
 *
 * Every entry we write carries `X-RedDev-WebApp=<url>`. That is how the
 * Catalogue knows which launchers are ours, which is what makes a URL
 * somebody typed removable later: the catalogue below is a starting
 * list, not the set of things that can exist. On Windows the marker has
 * nowhere to live — a .lnk is a binary format read through COM — so a
 * shortcut there is identified by the folder it is in, and a custom one
 * reports its name without its URL. That is enough to offer its removal,
 * which is all the Catalogue asks.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { RedError } from "./log.ts";
import type { Platform } from "./platform.ts";

export interface WebApp {
  name: string;
  url: string;
  /** PNG icon, fetched once into the user's icon directory. */
  icon?: string;
}

/**
 * Kept short on purpose. omakub offers four; a list of thirty would be
 * a directory, and the point is a handful of pages you actually keep
 * open all day. Anything else is a URL the person types.
 */
export const WEB_APPS: readonly WebApp[] = [
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
    name: "GitHub",
    url: "https://github.com/",
    icon: "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/github.png",
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
];

/**
 * The three that arrive ticked.
 *
 * Not a ranking of the six. These are the pages this project's own work
 * happens in — two agent hosts and the place the code lives — so they
 * are the ones a fresh machine is most likely to want a window for. The
 * rest stay one space bar away in the same list, which is the whole
 * difference between a recommendation and a decision.
 */
export const RECOMMENDED_WEB_APPS: readonly string[] = ["ChatGPT", "Claude", "GitHub"];

/** One row of the Catalogue's web-app section. */
export interface WebAppRow {
  app: WebApp;
  installed: boolean;
  /** Whether the list opens with this one ticked. */
  ticked: boolean;
}

/**
 * The rows the Catalogue offers, and which of them arrive ticked.
 *
 * Two rules, and the second is the one that makes unticking mean
 * something: a page already on this machine is always ticked, so leaving
 * the list alone changes nothing and the only way to remove something is
 * to deliberately take the tick off it. The recommendations are ticked
 * on top of that, which is what makes a fresh machine's list a
 * suggestion rather than an empty form.
 *
 * Anything installed that is not in the catalogue — a URL somebody typed
 * — is listed after it, because the alternative is a page you can
 * install and then never see again.
 */
export function webAppCatalogue(installed: readonly WebApp[] = []): WebAppRow[] {
  const isInstalled = (name: string): boolean => installed.some((a) => a.name === name);
  const rows: WebAppRow[] = WEB_APPS.map((app) => ({
    app,
    installed: isInstalled(app.name),
    ticked: isInstalled(app.name) || RECOMMENDED_WEB_APPS.includes(app.name),
  }));
  for (const app of installed) {
    if (WEB_APPS.some((a) => a.name === app.name)) continue;
    rows.push({ app, installed: true, ticked: true });
  }
  return rows;
}

/** The file-name stem for an app, on both targets. */
export function webAppSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Seams. Every one of these is answered by the machine in production and
 * by the test otherwise, so nothing here needs a desktop to be pinned.
 */
export interface WebAppEnv {
  home?: string;
  appData?: string;
  /** Resolve a command on PATH — the Chromium-family probe. */
  which?: (cmd: string) => boolean;
  /** Fetch the icon bytes. */
  download?: (url: string) => Promise<Uint8Array>;
  /** Run the PowerShell that writes a .lnk, on the Windows side. */
  powershell?: (script: string) => Promise<{ ok: boolean; out: string }>;
}

/**
 * A Chromium-family browser, which is what `--app=` requires. Firefox
 * has no equivalent that produces a chromeless window, so a machine
 * with only Firefox gets a clear refusal rather than a broken launcher.
 */
export const CHROMIUM_BINARIES: readonly string[] = [
  "google-chrome",
  "chromium",
  "chromium-browser",
  "brave-browser",
  "microsoft-edge",
];

/**
 * The same list on Windows, as paths rather than names.
 *
 * Edge is last and is the reason the Windows side never reports "no
 * browser": it ships with the OS, so the fallback is always present.
 * PowerShell resolves these because only the Windows side can — under a
 * converge driven from WSL, `C:\Program Files` is not a path this
 * process can stat.
 */
export const WINDOWS_BROWSERS: readonly string[] = [
  "$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe",
  "${env:ProgramFiles(x86)}\\Google\\Chrome\\Application\\chrome.exe",
  "$env:LOCALAPPDATA\\Google\\Chrome\\Application\\chrome.exe",
  "$env:ProgramFiles\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
  "${env:ProgramFiles(x86)}\\Microsoft\\Edge\\Application\\msedge.exe",
  "$env:ProgramFiles\\Microsoft\\Edge\\Application\\msedge.exe",
];

function home(env: WebAppEnv): string {
  const h = env.home ?? process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new RedError("neither HOME nor USERPROFILE is set");
  return h;
}

export function findBrowser(env: WebAppEnv = {}): string | null {
  const which = env.which ?? ((cmd: string) => Bun.which(cmd) !== null);
  for (const bin of CHROMIUM_BINARIES) if (which(bin)) return bin;
  return null;
}

/**
 * Whether this machine can hold a web app at all, and why not when it
 * cannot.
 *
 * WSL is answered first and on its own terms. Its `caps.gui` is false
 * and the generic "no desktop session" sentence would be technically
 * true there, but it sends the reader looking for a display they are
 * never going to install — the actual fact is that the desktop belongs
 * to the Windows host, which is where the shortcut goes.
 */
export function webAppSupport(p: Platform, env: WebAppEnv = {}): { ok: boolean; reason: string } {
  if (p.env === "wsl") {
    return {
      ok: false,
      reason:
        "WSL has no freedesktop menu of its own — a .desktop entry here is read by " +
        "nothing; install web apps from the Windows side",
    };
  }
  if (p.os === "windows") return { ok: true, reason: "" };
  if (!p.caps.gui) return { ok: false, reason: "no desktop session to show a launcher in" };
  if (!findBrowser(env)) {
    return { ok: false, reason: "no Chromium-family browser; --app= has no Firefox equivalent" };
  }
  return { ok: true, reason: "" };
}

export interface WebAppDirs {
  /** Where the launcher itself is written. */
  entries: string;
  /** Where its icon is fetched to. */
  icons: string;
}

export function webAppDirs(p: Platform, env: WebAppEnv = {}): WebAppDirs {
  if (p.os === "windows") {
    const appData = env.appData ?? process.env["APPDATA"] ?? `${home(env)}/AppData/Roaming`;
    // Its own folder under the Start Menu, because on Windows the folder
    // is the marker: everything in it is a web app red-dev wrote.
    const dir = `${appData}/Microsoft/Windows/Start Menu/Programs/red-dev/Web Apps`;
    return { entries: dir, icons: `${dir}/icons` };
  }
  const dir = `${home(env)}/.local/share/applications`;
  return { entries: dir, icons: `${dir}/icons` };
}

/** The two paths one app owns, which are also the two removal deletes. */
export function webAppFiles(
  p: Platform,
  name: string,
  env: WebAppEnv = {},
): { entry: string; icon: string } {
  const dirs = webAppDirs(p, env);
  const slug = webAppSlug(name);
  return {
    entry: p.os === "windows" ? `${dirs.entries}/${name}.lnk` : `${dirs.entries}/${slug}.desktop`,
    icon: `${dirs.icons}/${slug}.png`,
  };
}

/**
 * A name and a URL we are willing to write into a launcher.
 *
 * The catalogue above is trusted; a URL somebody typed is not, and both
 * reach the same two code paths — a shell-free `Bun.write` on Linux and
 * a PowerShell string on Windows. A quote in either field would end the
 * quoting in the Exec line or in `$s.Arguments` and turn the rest into
 * something else, so both are refused before either path is built rather
 * than escaped differently per target.
 */
export function validateWebApp(app: WebApp): string | null {
  if (app.name.trim() === "") return "a web app needs a name";
  if (/["'`\\\n\r]/.test(app.name)) return `${app.name}: a name cannot contain quotes or backslashes`;
  if (webAppSlug(app.name) === "") return `${app.name}: a name needs at least one letter or digit`;
  if (/["'`\\\s]/.test(app.url)) return `${app.url}: a URL cannot contain quotes or spaces`;
  let parsed: URL;
  try {
    parsed = new URL(app.url);
  } catch {
    return `${app.url}: not a URL`;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return `${app.url}: only http and https open in a browser window`;
  }
  if (app.icon !== undefined && /["'`\\\s]/.test(app.icon)) {
    return `${app.icon}: an icon URL cannot contain quotes or spaces`;
  }
  return null;
}

function assertValid(app: WebApp): void {
  const problem = validateWebApp(app);
  if (problem) throw new RedError(problem);
}

/** The marker key every entry we write carries, and nothing else does. */
export const WEB_APP_MARKER = "X-RedDev-WebApp";

/**
 * The freedesktop entry, byte for byte.
 *
 * `--app=` is what removes the tab strip; `--class` makes the window
 * group under its own icon rather than under the browser's, which is the
 * difference between an alt-tab entry that says ChatGPT and one that
 * says Google Chrome. `Categories=Network;` is a registered main
 * category — omakub writes `GTK;`, which is not one, and a desktop file
 * validator says so.
 */
export function desktopEntry(app: WebApp, browser: string, iconPath: string | null): string {
  assertValid(app);
  const lines = [
    "[Desktop Entry]",
    "Version=1.0",
    "Type=Application",
    `Name=${app.name}`,
    `Comment=${app.name}, in its own window`,
    `Exec=${browser} --app="${app.url}" --name="${app.name}" --class="${app.name}"`,
  ];
  // Omitted rather than pointed at a file that is not there: a URL added
  // without an icon still gets a working launcher, wearing the desktop's
  // generic application icon.
  if (iconPath) lines.push(`Icon=${iconPath}`);
  lines.push(
    "Terminal=false",
    "StartupNotify=true",
    `StartupWMClass=${app.name}`,
    "Categories=Network;",
    "MimeType=text/html;text/xml;application/xhtml_xml;",
    `${WEB_APP_MARKER}=${app.url}`,
    "",
  );
  return lines.join("\n");
}

/**
 * What the Windows shortcut passes to the browser.
 *
 * Only `--app=`. The two X11 switches the Linux Exec line carries have
 * no meaning here — Windows has no WM_CLASS — and Chrome gives an
 * `--app` window the site's own favicon and its own taskbar button
 * without being asked.
 */
export function windowsShortcutArgs(app: WebApp): string {
  assertValid(app);
  return `--app="${app.url}"`;
}

/**
 * The PowerShell that writes one .lnk.
 *
 * The browser is resolved on the Windows side, for the reason
 * src/hotkeys.ts gives about the same crossing: under WSL this process
 * is Linux and cannot stat `C:\Program Files`. The shortcut's icon is
 * the browser's, because a .lnk's IconLocation wants an .ico and the
 * catalogue's icons are PNG — the window itself still wears the site's
 * favicon.
 */
export function windowsShortcutScript(app: WebApp, dir: string): string {
  assertValid(app);
  const candidates = WINDOWS_BROWSERS.map((path) => `  "${path}"`).join(",\n");
  // The directory is the one path here we did not choose — it comes from
  // %APPDATA%, and a Windows account named O'Brien puts an apostrophe in
  // it. Doubling is how a single-quoted PowerShell string carries one.
  const quoted = dir.replace(/\//g, "\\").replace(/'/g, "''");
  return `
$ErrorActionPreference = 'Stop'
$dir = '${quoted}'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$browser = @(
${candidates}
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $browser) { throw 'no Chromium-family browser on this machine' }
$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $dir '${app.name}.lnk'))
$s.TargetPath = $browser
$s.Arguments = '${windowsShortcutArgs(app)}'
$s.Description = '${app.name}, in its own window'
$s.Save()
"${app.name} -> $browser"
`.trim();
}

async function fetchIcon(url: string, env: WebAppEnv): Promise<Uint8Array> {
  if (env.download) return await env.download(url);
  const res = await fetch(url);
  if (!res.ok) throw new RedError(`icon download failed ${res.status}: ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function runPowershell(
  script: string,
  env: WebAppEnv,
): Promise<{ ok: boolean; out: string }> {
  if (env.powershell) return await env.powershell(script);
  const proc = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  const err = (await new Response(proc.stderr).text()).trim();
  const code = await proc.exited;
  return { ok: code === 0, out: code === 0 ? out : err };
}

/**
 * Install one, and answer with the path that now exists — which is what
 * the caller reports and what a person checks when a menu does not show
 * what they just ticked.
 */
export async function installWebApp(
  p: Platform,
  app: WebApp,
  env: WebAppEnv = {},
): Promise<string> {
  assertValid(app);
  const files = webAppFiles(p, app.name, env);

  if (p.os === "windows") {
    const dirs = webAppDirs(p, env);
    const result = await runPowershell(windowsShortcutScript(app, dirs.entries), env);
    if (!result.ok) {
      throw new RedError(`${app.name}: ${result.out.split("\n")[0] ?? "could not write the shortcut"}`);
    }
    return files.entry;
  }

  const browser = findBrowser(env);
  if (!browser) throw new RedError("no Chromium-family browser found");

  const dirs = webAppDirs(p, env);
  mkdirSync(dirs.entries, { recursive: true });

  let iconPath: string | null = null;
  if (app.icon) {
    mkdirSync(dirs.icons, { recursive: true });
    // Fetched once. A re-tick of something already installed should cost
    // a file write, not a download.
    if (!existsSync(files.icon)) await Bun.write(files.icon, await fetchIcon(app.icon, env));
    iconPath = files.icon;
  }

  await Bun.write(files.entry, desktopEntry(app, browser, iconPath));
  return files.entry;
}

/**
 * Everything red-dev put on this machine, catalogue or not.
 *
 * Read from the launchers themselves rather than from a list we keep
 * beside them: a state file and a menu directory disagree the first time
 * somebody deletes an entry by hand, and the directory is the one the
 * desktop actually reads.
 */
export function installedWebApps(p: Platform, env: WebAppEnv = {}): WebApp[] {
  const dirs = webAppDirs(p, env);
  if (!existsSync(dirs.entries)) return [];

  if (p.os === "windows") {
    return readdirSync(dirs.entries)
      .filter((f) => f.endsWith(".lnk"))
      .map((f) => {
        const name = f.slice(0, -".lnk".length);
        // A .lnk cannot be read back without COM, so the URL comes from
        // the catalogue when the name is in it, and is left unknown when
        // it is not. Removal needs only the name.
        const known = WEB_APPS.find((a) => a.name === name);
        return { name, url: known?.url ?? "", icon: known?.icon };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  const out: WebApp[] = [];
  for (const file of readdirSync(dirs.entries).sort()) {
    if (!file.endsWith(".desktop")) continue;
    let body: string;
    try {
      body = readFileSync(`${dirs.entries}/${file}`, "utf8");
    } catch {
      continue;
    }
    const url = /^X-RedDev-WebApp=(.*)$/m.exec(body)?.[1]?.trim();
    if (url === undefined) continue;
    const name = /^Name=(.*)$/m.exec(body)?.[1]?.trim();
    if (!name) continue;
    const icon = /^Icon=(.*)$/m.exec(body)?.[1]?.trim();
    out.push(icon ? { name, url, icon } : { name, url });
  }
  return out;
}

/**
 * The exact inverse of an install: the launcher and the icon it fetched,
 * and the paths that were really deleted so the caller can name them.
 *
 * Node's own remove rather than a spawned `rm -f`, which the previous
 * version used and which does not exist on the one target where the
 * entry is a .lnk.
 */
export function removeWebApp(p: Platform, name: string, env: WebAppEnv = {}): string[] {
  const files = webAppFiles(p, name, env);
  const removed: string[] = [];
  for (const path of [files.entry, files.icon]) {
    if (!existsSync(path)) continue;
    rmSync(path, { force: true });
    removed.push(path);
  }
  return removed;
}
