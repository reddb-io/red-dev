import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { themeNames } from "./themes.ts";
import type { Platform } from "./platform.ts";
import { customWallpaperDigest, wallpaperSlugFor } from "./preferences.ts";
import { encodePng } from "./png.ts";
import {
  customWallpaperDir,
  importCustomWallpaper,
  resolveWallpaperArt,
  sweepCustomWallpapers,
  wallpaperSourcePath,
} from "./wallpaper.ts";

const desktop: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

const wsl: Platform = {
  ...desktop,
  os: "linux",
  env: "wsl",
  caps: { ...desktop.caps, gui: false },
};

async function onFreshMachine<T>(run: (home: string) => Promise<T>): Promise<T> {
  const previous = process.env["HOME"];
  const home = mkdtempSync(`${tmpdir()}/red-dev-custom-wallpaper-`);
  process.env["HOME"] = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) delete process.env["HOME"];
    else process.env["HOME"] = previous;
  }
}

function png(): Uint8Array {
  return encodePng({
    width: 4,
    height: 3,
    data: new Uint8Array(4 * 3 * 4).fill(180),
  });
}

describe("versioned wallpapers", () => {
  test("commits one generated wallpaper for every theme", () => {
    const wallpapers = readdirSync(`${import.meta.dir}/../assets/wallpapers`)
      .filter((name) => name.endsWith(".png"))
      .map((name) => name.replace(/\.png$/, ""))
      .sort();

    expect(wallpapers).toEqual([...themeNames()].sort());
  });
});

describe("the independent wallpaper choice", () => {
  test("follows the theme until a Red wallpaper is pinned", () => {
    expect(wallpaperSlugFor(undefined, "cobalt")).toBe("cobalt");
    expect(wallpaperSlugFor("flare", "cobalt")).toBe("flare");
  });

  test("an invalid edited value falls back to the theme", () => {
    expect(wallpaperSlugFor("/tmp/random.png", "marble")).toBe("marble");
  });
});

describe("custom wallpaper imports", () => {
  test("copies an absolute PNG and persists only its digest", async () => {
    await onFreshMachine(async (home) => {
      const source = `${home}/my-wall.png`;
      writeFileSync(source, png());

      const imported = await importCustomWallpaper(source, desktop);
      const digest = customWallpaperDigest(imported.preference);

      expect(digest).toHaveLength(64);
      expect(imported.preference).not.toContain(source);
      expect(imported.path).toBe(`${await customWallpaperDir(desktop)}/${digest}.png`);
      expect(existsSync(imported.path)).toBe(true);
      const art = await resolveWallpaperArt(desktop, "cobalt", imported.preference);
      expect(art.path).toBe(imported.path);
      expect(art.theme.name).toBe("Cobalt");
    });
  });

  test("downloads the exact HTTPS URL including its query string", async () => {
    await onFreshMachine(async () => {
      let requested = "";
      const imported = await importCustomWallpaper(
        "https://example.com/img/wall.png?variant=wide&token=secret",
        desktop,
        {
          fetch: async (input) => {
            requested = String(input);
            return new Response(png(), { status: 200 });
          },
        },
      );

      expect(requested).toBe("https://example.com/img/wall.png?variant=wide&token=secret");
      expect(imported.preference).not.toContain("example.com");
      expect(imported.preference).not.toContain("secret");
    });
  });

  test("refuses an HTTPS request that redirects to plaintext or exceeds the limit", async () => {
    await onFreshMachine(async () => {
      const redirected = new Response(png(), { status: 200 });
      Object.defineProperty(redirected, "url", { value: "http://example.com/final.png" });
      await expect(importCustomWallpaper("https://example.com/wall.png", desktop, {
        fetch: async () => redirected,
      })).rejects.toThrow(/redirected outside HTTPS/);

      await expect(importCustomWallpaper("https://example.com/huge.png", desktop, {
        fetch: async () => new Response(png(), {
          status: 200,
          headers: { "content-length": String(33 * 1024 * 1024) },
        }),
      })).rejects.toThrow(/32 MB/);
    });
  });

  test("refuses plaintext URLs, relative paths and non-PNG bytes", async () => {
    await onFreshMachine(async (home) => {
      await expect(importCustomWallpaper("http://example.com/wall.png", desktop)).rejects.toThrow(
        /HTTPS/,
      );
      await expect(importCustomWallpaper("Pictures/wall.png", desktop)).rejects.toThrow(/absolute/);
      const bad = `${home}/bad.png`;
      writeFileSync(bad, "not a png");
      await expect(importCustomWallpaper(bad, desktop)).rejects.toThrow(/PNG/);
    });
  });

  test("translates a fully qualified Windows path when invoked from WSL", async () => {
    let received = "";
    const translated = await wallpaperSourcePath(
      "C:\\Users\\filipe\\Pictures\\wall.png",
      wsl,
      async (path) => {
        received = path;
        return "/mnt/c/Users/filipe/Pictures/wall.png";
      },
    );
    expect(received).toBe("C:\\Users\\filipe\\Pictures\\wall.png");
    expect(translated).toBe("/mnt/c/Users/filipe/Pictures/wall.png");
  });

  test("keeps the fully qualified path native when invoked on Windows", async () => {
    const windows = { ...wsl, os: "windows", env: "windows" } as Platform;
    expect(await wallpaperSourcePath("C:\\Users\\filipe\\wall.png", windows)).toBe(
      "C:\\Users\\filipe\\wall.png",
    );
  });

  test("sweeps only superseded managed copies", async () => {
    await onFreshMachine(async (home) => {
      const first = `${home}/first.png`;
      const second = `${home}/second.png`;
      writeFileSync(first, png());
      writeFileSync(second, encodePng({
        width: 4,
        height: 3,
        data: new Uint8Array(4 * 3 * 4).fill(90),
      }));
      const one = await importCustomWallpaper(first, desktop);
      const two = await importCustomWallpaper(second, desktop);

      expect(await sweepCustomWallpapers(desktop, two.preference)).toEqual([
        `${customWallpaperDigest(one.preference)}.png`,
      ]);
      expect(existsSync(one.path)).toBe(false);
      expect(existsSync(two.path)).toBe(true);
    });
  });
});
