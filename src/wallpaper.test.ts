import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { themeNames } from "./themes.ts";
import type { Platform } from "./platform.ts";
import { customWallpaperDigest, wallpaperSlugFor, writePreferences } from "./preferences.ts";
import { encodePng } from "./png.ts";
import {
  currentWallpaper,
  currentWallpaperLabel,
  customWallpaperDir,
  imageFormat,
  importCustomWallpaper,
  isPng,
  keepCurrentWallpaper,
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

/** Bytes that start like a JPEG and are otherwise nothing. */
function jpeg(): Uint8Array {
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
}

describe("images that are not PNGs", () => {
  test("are recognised by their first bytes, whatever the path says", () => {
    // Windows keeps the wallpaper set through Settings as
    // `TranscodedWallpaper`, a JPEG with no extension at all.
    expect(isPng(png())).toBe(true);
    expect(isPng(jpeg())).toBe(false);
    expect(imageFormat(png()).name).toBe("PNG");
    expect(imageFormat(jpeg())).toEqual({ name: "JPEG", ext: "jpg" });
    expect(imageFormat(new Uint8Array([0x42, 0x4d, 0, 0])).name).toBe("BMP");
    expect(imageFormat(new Uint8Array([1, 2, 3])).ext).toBe("img");
  });

  test("are converted before they are imported, and the PNG is what is kept", async () => {
    await onFreshMachine(async (home) => {
      const source = `${home}/TranscodedWallpaper`;
      writeFileSync(source, jpeg());
      const seen: string[] = [];
      const imported = await importCustomWallpaper(source, desktop, {
        convert: async (bytes) => {
          seen.push(imageFormat(bytes).name);
          return png();
        },
      });
      expect(seen).toEqual(["JPEG"]);
      const digest = customWallpaperDigest(imported.preference)!;
      expect(digest).toBe(new Bun.CryptoHasher("sha256").update(png()).digest("hex"));
      expect([...(await Bun.file(imported.path).bytes())]).toEqual([...png()]);
    });
  });

  test("a PNG never goes through the converter", async () => {
    await onFreshMachine(async (home) => {
      const source = `${home}/wall.png`;
      writeFileSync(source, png());
      let converted = false;
      await importCustomWallpaper(source, desktop, {
        convert: async () => {
          converted = true;
          return png();
        },
      });
      expect(converted).toBe(false);
    });
  });

  test("a converter that cannot help is the import's failure, with the format named", async () => {
    await onFreshMachine(async (home) => {
      const source = `${home}/wall.jpg`;
      writeFileSync(source, jpeg());
      await expect(
        importCustomWallpaper(source, desktop, {
          convert: async () => {
            throw new Error("the image is JPEG, not PNG, and nothing here could convert it");
          },
        }),
      ).rejects.toThrow("JPEG");
    });
  });
});

describe("keeping the desktop's own image", () => {
  const root = (home: string) => `${home}/.local/share/red-dev`;
  const inUse = (path: string | null) => async () => path;

  test("somebody else's image is external, and named for the person", async () => {
    await onFreshMachine(async (home) => {
      mkdirSync(`${home}/Pictures`, { recursive: true });
      const path = `${home}/Pictures/beach.jpg`;
      writeFileSync(path, jpeg());
      expect(await currentWallpaper(desktop, { inUse: inUse(path) })).toEqual({
        kind: "external",
        path,
      });
      expect(await currentWallpaperLabel(desktop, { inUse: inUse(path) })).toBe("beach.jpg");
    });
  });

  test("red-dev's own images are recognised as its own", async () => {
    await onFreshMachine(async (home) => {
      const digest = "a".repeat(64);
      for (const rel of ["wallpapers/dark-0123abcd.png", `custom-wallpapers/${digest}.png`, "redwall/x.png"]) {
        mkdirSync(`${root(home)}/${rel}`.replace(/\/[^/]+$/, ""), { recursive: true });
        writeFileSync(`${root(home)}/${rel}`, png());
      }
      const sheet = `${root(home)}/wallpapers/dark-0123abcd.png`;
      expect(await currentWallpaper(desktop, { inUse: inUse(sheet) })).toEqual({
        kind: "wallpaper",
        path: sheet,
        slug: "dark",
      });
      const custom = `${root(home)}/custom-wallpapers/${digest}.png`;
      expect(await currentWallpaper(desktop, { inUse: inUse(custom) })).toEqual({
        kind: "custom",
        path: custom,
        preference: `custom:${digest}`,
      });
      const redwall = `${root(home)}/redwall/x.png`;
      expect(await currentWallpaper(desktop, { inUse: inUse(redwall) })).toEqual({
        kind: "redwall",
        path: redwall,
      });
      // Nothing to offer the interview for a desktop already showing a
      // bundled sheet or a Redwall; the import it holds is offered.
      expect(await currentWallpaperLabel(desktop, { inUse: inUse(sheet) })).toBeNull();
      expect(await currentWallpaperLabel(desktop, { inUse: inUse(redwall) })).toBeNull();
      expect(await currentWallpaperLabel(desktop, { inUse: inUse(custom) })).not.toBeNull();
    });
  });

  test("a desktop that cannot be read, or points at nothing, has nothing to keep", async () => {
    await onFreshMachine(async (home) => {
      expect(await currentWallpaper(desktop, { inUse: inUse(null) })).toBeNull();
      expect(await currentWallpaper(desktop, { inUse: inUse(`${home}/gone.png`) })).toBeNull();
      expect(
        await currentWallpaper(desktop, {
          inUse: async () => {
            throw new Error("no gsettings");
          },
        }),
      ).toBeNull();
      expect(await currentWallpaperLabel(desktop, { inUse: inUse(null) })).toBeNull();
    });
  });

  test("keeping an external image imports it under its digest and pins it", async () => {
    await onFreshMachine(async (home) => {
      const path = `${home}/beach.jpg`;
      writeFileSync(path, jpeg());
      const kept = await keepCurrentWallpaper(desktop, {
        inUse: inUse(path),
        convert: async () => png(),
      });
      const digest = new Bun.CryptoHasher("sha256").update(png()).digest("hex");
      expect(kept.preference).toBe(`custom:${digest}`);
      expect(kept.label).toContain("beach.jpg");
      expect(existsSync(`${await customWallpaperDir(desktop)}/${digest}.png`)).toBe(true);
      // And it is the art Redwall then composes over.
      const art = await resolveWallpaperArt(desktop, "cobalt", kept.preference);
      expect(art.key).toBe(`custom-${digest}`);
    });
  });

  test("keeping red-dev's own image names the preference that already produces it", async () => {
    await onFreshMachine(async (home) => {
      const sheet = `${root(home)}/wallpapers/flare-0123abcd.png`;
      mkdirSync(`${root(home)}/wallpapers`, { recursive: true });
      writeFileSync(sheet, png());
      expect((await keepCurrentWallpaper(desktop, { inUse: inUse(sheet) })).preference).toBe("flare");

      // A Redwall is never imported — the state it shows is baked into
      // its pixels. The art under it is whatever was recorded.
      const redwall = `${root(home)}/redwall/x.png`;
      mkdirSync(`${root(home)}/redwall`, { recursive: true });
      writeFileSync(redwall, png());
      await writePreferences(desktop, { wallpaper: "marble" });
      expect((await keepCurrentWallpaper(desktop, { inUse: inUse(redwall) })).preference).toBe("marble");
      await writePreferences(desktop, { wallpaper: undefined });
      expect((await keepCurrentWallpaper(desktop, { inUse: inUse(redwall) })).preference).toBeUndefined();
    });
  });

  test("with nothing on the desktop, keeping it is refused rather than guessed", async () => {
    await onFreshMachine(async () => {
      await expect(keepCurrentWallpaper(desktop, { inUse: inUse(null) })).rejects.toThrow("no desktop wallpaper");
    });
  });
});
