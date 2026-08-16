/**
 * What a web app writes, where, and what unticking it takes back.
 *
 * The artefact is pinned rather than described, on both targets, for the
 * reason the Panel tests give: this process runs on one machine and the
 * module has to be right about two. A `.desktop` file with a wrong Exec
 * line and a shortcut with wrong arguments both fail the same way — a
 * launcher that opens something, so nothing looks broken until you look
 * at the window and it has a tab strip.
 *
 * The third target is the interesting one. WSL is not unsupported by
 * omission here; it is refused, with the reason, because that is the
 * target where writing the file would look like it worked.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Platform } from "./platform.ts";
import {
  desktopEntry,
  installedWebApps,
  installWebApp,
  RECOMMENDED_WEB_APPS,
  removeWebApp,
  validateWebApp,
  WEB_APPS,
  webAppCatalogue,
  webAppDirs,
  webAppFiles,
  webAppSlug,
  webAppSupport,
  windowsShortcutArgs,
  windowsShortcutScript,
} from "./webapps.ts";

function machine(over: Partial<Platform>): Platform {
  return {
    os: "linux",
    distro: "ubuntu",
    version: "24.04",
    codename: "noble",
    env: "desktop",
    arch: "x64",
    caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
    ...over,
  };
}

const DESKTOP = machine({});
const WSL = machine({ env: "wsl", caps: { apt: true, gui: false, systemd: false, winget: true, flatpak: false } });
const WINDOWS = machine({
  os: "windows",
  distro: null,
  version: null,
  codename: null,
  env: "windows",
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false },
});
const SERVER = machine({ env: "server", caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false } });

/** Every Chromium-family name resolves; nothing else does. */
const hasChrome = { which: (cmd: string) => cmd === "google-chrome" };

function scratch(): string {
  return mkdtempSync(`${tmpdir()}/red-webapps-`);
}

const CHATGPT = WEB_APPS.find((a) => a.name === "ChatGPT")!;

describe("the Linux entry", () => {
  test("is pinned, line for line", () => {
    const entry = desktopEntry(CHATGPT, "google-chrome", "/home/x/.local/share/applications/icons/chatgpt.png");

    expect(entry).toBe(
      [
        "[Desktop Entry]",
        "Version=1.0",
        "Type=Application",
        "Name=ChatGPT",
        "Comment=ChatGPT, in its own window",
        'Exec=google-chrome --app="https://chatgpt.com/" --name="ChatGPT" --class="ChatGPT"',
        "Icon=/home/x/.local/share/applications/icons/chatgpt.png",
        "Terminal=false",
        "StartupNotify=true",
        "StartupWMClass=ChatGPT",
        "Categories=Network;",
        "MimeType=text/html;text/xml;application/xhtml_xml;",
        "X-RedDev-WebApp=https://chatgpt.com/",
        "",
      ].join("\n"),
    );
  });

  test("uses the browser it was given, not a hard-coded one", () => {
    // The whole reason the shell function is retired: it wrote
    // google-chrome onto machines that have chromium and nothing else.
    expect(desktopEntry(CHATGPT, "brave-browser", null)).toContain(
      'Exec=brave-browser --app="https://chatgpt.com/"',
    );
  });

  test("omits Icon rather than pointing at a file it never fetched", () => {
    const entry = desktopEntry({ name: "Intranet", url: "https://intranet.example/" }, "chromium", null);
    expect(entry).not.toContain("Icon=");
    // Still a launcher, still ours, still removable.
    expect(entry).toContain("X-RedDev-WebApp=https://intranet.example/");
  });

  test("marks every entry as ours, which is what makes a typed URL removable", () => {
    expect(desktopEntry(CHATGPT, "google-chrome", null)).toContain("X-RedDev-WebApp=");
  });
});

describe("the Windows shortcut", () => {
  test("carries --app and nothing else", () => {
    // The two X11 switches the Exec line carries mean nothing here, and
    // an argument list that names a WM_CLASS on Windows is cargo.
    expect(windowsShortcutArgs(CHATGPT)).toBe('--app="https://chatgpt.com/"');
  });

  test("is written by PowerShell, against a browser the Windows side resolves", () => {
    const script = windowsShortcutScript(CHATGPT, "C:/Users/x/AppData/Roaming/red-dev/Web Apps");

    expect(script).toContain("$s.Arguments = '--app=\"https://chatgpt.com/\"'");
    expect(script).toContain("CreateShortcut((Join-Path $dir 'ChatGPT.lnk'))");
    expect(script).toContain("$s.TargetPath = $browser");
    expect(script).toContain("$s.Save()");
    // Resolved there rather than here: under WSL this process is Linux
    // and cannot stat C:\Program Files.
    expect(script).toContain('"$env:ProgramFiles\\Google\\Chrome\\Application\\chrome.exe"');
    // Edge ships with Windows, so the fallback is always present.
    expect(script).toContain("Microsoft\\Edge\\Application\\msedge.exe");
    expect(script).toContain("if (-not $browser) { throw");
    expect(script).toContain("$dir = 'C:\\Users\\x\\AppData\\Roaming\\red-dev\\Web Apps'");
  });

  test("survives an account name with an apostrophe in it", () => {
    const script = windowsShortcutScript(CHATGPT, "C:/Users/O'Brien/AppData/Roaming/red-dev");
    // Doubled, which is how a single-quoted PowerShell string carries
    // one. Left alone it would end the string and run the rest.
    expect(script).toContain("$dir = 'C:\\Users\\O''Brien\\AppData\\Roaming\\red-dev'");
  });

  test("goes in its own Start Menu folder, which is how Windows marks it as ours", () => {
    const dirs = webAppDirs(WINDOWS, { appData: "C:/Users/x/AppData/Roaming" });
    expect(dirs.entries).toBe(
      "C:/Users/x/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/red-dev/Web Apps",
    );
    expect(webAppFiles(WINDOWS, "Google Photos", { appData: "C:/Users/x/AppData/Roaming" }).entry)
      .toEndWith("/red-dev/Web Apps/Google Photos.lnk");
  });
});

describe("where a web app is offered", () => {
  test("WSL is skipped, and the reason is WSL's rather than the generic one", () => {
    const support = webAppSupport(WSL, hasChrome);

    expect(support.ok).toBe(false);
    // The failure this sentence exists to prevent: "no desktop session"
    // is true under WSL and sends the reader off to install a display
    // they will never have. The launcher belongs on the Windows side.
    expect(support.reason).toContain("read by nothing");
    expect(support.reason).toContain("Windows side");
    expect(support.reason).not.toContain("no desktop session");
  });

  test("a Linux desktop with a Chromium-family browser is supported", () => {
    expect(webAppSupport(DESKTOP, hasChrome)).toEqual({ ok: true, reason: "" });
  });

  test("native Windows is supported, because a shortcut is the equivalent", () => {
    expect(webAppSupport(WINDOWS, { which: () => false }).ok).toBe(true);
  });

  test("a headless server is skipped", () => {
    expect(webAppSupport(SERVER, hasChrome).reason).toContain("no desktop session");
  });

  test("Firefox alone is a refusal, not a broken launcher", () => {
    const support = webAppSupport(DESKTOP, { which: (cmd) => cmd === "firefox" });
    expect(support.ok).toBe(false);
    expect(support.reason).toContain("Firefox");
  });
});

describe("the pre-ticked set", () => {
  test("is ChatGPT, Claude and GitHub", () => {
    expect([...RECOMMENDED_WEB_APPS]).toEqual(["ChatGPT", "Claude", "GitHub"]);
  });

  test("every recommendation is a catalogue entry", () => {
    // A recommendation naming something that is not on the list would
    // pre-tick nothing, silently.
    for (const name of RECOMMENDED_WEB_APPS) {
      expect(WEB_APPS.map((a) => a.name)).toContain(name);
    }
  });

  test("the rest stay in the catalogue rather than being dropped", () => {
    const rest = WEB_APPS.map((a) => a.name).filter((n) => !RECOMMENDED_WEB_APPS.includes(n));
    expect(rest).toEqual(["Google Photos", "Google Contacts", "Tailscale"]);
  });

  test("is what a fresh machine's Catalogue opens with", () => {
    const rows = webAppCatalogue([]);

    expect(rows.filter((r) => r.ticked).map((r) => r.app.name)).toEqual([
      "ChatGPT",
      "Claude",
      "GitHub",
    ]);
    // Offered, and only that. The point of a recommendation is that the
    // rest are one space bar away in the same list.
    expect(rows.map((r) => r.app.name)).toEqual(WEB_APPS.map((a) => a.name));
    expect(rows.every((r) => !r.installed)).toBe(true);
  });
});

describe("the Catalogue's rows", () => {
  test("tick everything already installed, so leaving the list alone changes nothing", () => {
    const rows = webAppCatalogue([{ name: "Tailscale", url: "https://login.tailscale.com/admin/" }]);

    const tailscale = rows.find((r) => r.app.name === "Tailscale");
    expect(tailscale?.installed).toBe(true);
    expect(tailscale?.ticked).toBe(true);
    // Which makes the untick the only way out — and that is the whole
    // contract: removal is a deliberate act, never a default.
    expect(rows.filter((r) => r.ticked).map((r) => r.app.name)).toEqual([
      "ChatGPT",
      "Claude",
      "GitHub",
      "Tailscale",
    ]);
  });

  test("list a typed URL after the catalogue, so it can be taken back out", () => {
    const rows = webAppCatalogue([{ name: "Intranet", url: "https://intranet.example/" }]);

    const last = rows[rows.length - 1];
    expect(last?.app.name).toBe("Intranet");
    expect(last?.installed).toBe(true);
    expect(last?.ticked).toBe(true);
  });

  test("do not list a catalogue entry twice when it is installed", () => {
    const rows = webAppCatalogue([{ name: "ChatGPT", url: "https://chatgpt.com/" }]);
    expect(rows.filter((r) => r.app.name === "ChatGPT")).toHaveLength(1);
  });
});

describe("install and its inverse, on a real directory", () => {
  test("writes the entry and fetches the icon once", async () => {
    const home = scratch();
    try {
      let downloads = 0;
      const env = {
        home,
        ...hasChrome,
        download: async () => {
          downloads++;
          return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
        },
      };

      const path = await installWebApp(DESKTOP, CHATGPT, env);
      expect(path).toBe(`${home}/.local/share/applications/chatgpt.desktop`);
      expect(existsSync(`${home}/.local/share/applications/icons/chatgpt.png`)).toBe(true);
      expect(downloads).toBe(1);

      // Re-ticking something already installed costs a file write, not a
      // download.
      await installWebApp(DESKTOP, CHATGPT, env);
      expect(downloads).toBe(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("removal deletes both the entry and its icon", async () => {
    const home = scratch();
    try {
      const env = { home, ...hasChrome, download: async () => new Uint8Array([1]) };
      await installWebApp(DESKTOP, CHATGPT, env);

      const files = webAppFiles(DESKTOP, "ChatGPT", { home });
      const removed = removeWebApp(DESKTOP, "ChatGPT", { home });

      // Both, and reported as both: an icon left behind is the bug the
      // shell function's remove had every time an app name and its icon
      // name disagreed.
      expect(removed).toEqual([files.entry, files.icon]);
      expect(existsSync(files.entry)).toBe(false);
      expect(existsSync(files.icon)).toBe(false);
      // And nothing else in the directory it shares with every other
      // launcher on the machine.
      expect(readdirSync(`${home}/.local/share/applications`)).toEqual(["icons"]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("removing something that was never installed is not an error", () => {
    const home = scratch();
    try {
      expect(removeWebApp(DESKTOP, "Tailscale", { home })).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("lists what red-dev wrote, and leaves every other launcher alone", async () => {
    const home = scratch();
    try {
      const env = { home, ...hasChrome, download: async () => new Uint8Array([1]) };
      await installWebApp(DESKTOP, CHATGPT, env);
      await installWebApp(DESKTOP, { name: "Intranet", url: "https://intranet.example/" }, env);

      // Somebody else's entry, in the same directory.
      writeFileSync(
        `${home}/.local/share/applications/firefox.desktop`,
        "[Desktop Entry]\nName=Firefox\nExec=firefox\n",
      );

      const installed = installedWebApps(DESKTOP, { home });
      expect(installed.map((a) => a.name)).toEqual(["ChatGPT", "Intranet"]);
      // The typed URL comes back with its URL, which is what makes it
      // offerable — and untickable — next time.
      expect(installed.find((a) => a.name === "Intranet")?.url).toBe("https://intranet.example/");
      expect(installed.map((a) => a.name)).not.toContain("Firefox");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("on Windows, everything in the folder is one of ours", () => {
    const appData = scratch();
    try {
      const dir = webAppDirs(WINDOWS, { appData }).entries;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/ChatGPT.lnk`, "");
      writeFileSync(`${dir}/Standup.lnk`, "");

      const installed = installedWebApps(WINDOWS, { appData });
      expect(installed.map((a) => a.name)).toEqual(["ChatGPT", "Standup"]);
      // The catalogue fills in what the .lnk cannot say; a typed one
      // reports its name and no URL, which is all removal needs.
      expect(installed.find((a) => a.name === "ChatGPT")?.url).toBe("https://chatgpt.com/");
      expect(installed.find((a) => a.name === "Standup")?.url).toBe("");
    } finally {
      rmSync(appData, { recursive: true, force: true });
    }
  });

  test("an unsupported target has nothing installed rather than throwing", () => {
    expect(installedWebApps(DESKTOP, { home: `${tmpdir()}/red-dev-nonexistent-home` })).toEqual([]);
  });
});

describe("a URL somebody typed", () => {
  test("is accepted when it is a URL", () => {
    expect(validateWebApp({ name: "Intranet", url: "https://intranet.example/wiki" })).toBeNull();
  });

  test("is refused when a quote would break out of the launcher", () => {
    // Both writers quote the URL — the Exec line and $s.Arguments — so a
    // quote in it does not escape into a different value, it ends the
    // quoting and turns the rest into something else.
    expect(validateWebApp({ name: "X", url: 'https://x/" --load-extension=/tmp/e "' })).toContain(
      "cannot contain quotes",
    );
    expect(validateWebApp({ name: 'A" --x', url: "https://x/" })).toContain("cannot contain quotes");
    expect(validateWebApp({ name: "A'; rm", url: "https://x/" })).toContain("cannot contain quotes");
  });

  test("is refused when it is not something a browser window opens", () => {
    expect(validateWebApp({ name: "X", url: "file:///etc/passwd" })).toContain("only http and https");
    expect(validateWebApp({ name: "X", url: "not a url" })).toBeTruthy();
  });

  test("needs a name a file can be called", () => {
    expect(validateWebApp({ name: "", url: "https://x/" })).toContain("needs a name");
    expect(validateWebApp({ name: "...", url: "https://x/" })).toContain("at least one letter");
  });

  test("refuses to install rather than writing half a launcher", async () => {
    const home = scratch();
    try {
      await expect(
        installWebApp(DESKTOP, { name: "X", url: "file:///etc/passwd" }, { home }),
      ).rejects.toThrow("only http and https");
      expect(existsSync(`${home}/.local/share/applications`)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("slugs", () => {
  test("are the file name, and survive a two-word app", () => {
    expect(webAppSlug("Google Photos")).toBe("google-photos");
    expect(webAppSlug("ChatGPT")).toBe("chatgpt");
  });

  test("every catalogue entry has a distinct one, so no two share a file", () => {
    const slugs = WEB_APPS.map((a) => webAppSlug(a.name));
    expect(new Set(slugs).size).toBe(WEB_APPS.length);
  });

  test("every catalogue entry is one this module would accept", () => {
    for (const app of WEB_APPS) expect(validateWebApp(app)).toBeNull();
  });
});
