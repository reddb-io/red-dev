import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { themeNames } from "./themes.ts";

describe("versioned wallpapers", () => {
  test("commits one generated wallpaper for every theme", () => {
    const wallpapers = readdirSync(`${import.meta.dir}/../assets/wallpapers`)
      .filter((name) => name.endsWith(".png"))
      .map((name) => name.replace(/\.png$/, ""))
      .sort();

    expect(wallpapers).toEqual([...themeNames()].sort());
  });
});
