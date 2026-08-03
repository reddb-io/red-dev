import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { applyNeovim } from "./theme-apply.ts";
import { THEMES } from "./themes.ts";

const savedHome = process.env["HOME"];

afterEach(() => {
  if (savedHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = savedHome;
});

const EXPECTED: Record<string, { plugin: string; colorscheme: string }> = {
  "tokyo-night": { plugin: "folke/tokyonight.nvim", colorscheme: "tokyonight" },
  catppuccin: { plugin: "catppuccin/nvim", colorscheme: "catppuccin-macchiato" },
  gruvbox: { plugin: "ellisonleao/gruvbox.nvim", colorscheme: "gruvbox" },
  everforest: { plugin: "neanias/everforest-nvim", colorscheme: "everforest" },
  kanagawa: { plugin: "rebelot/kanagawa.nvim", colorscheme: "kanagawa" },
  "matte-black": { plugin: "tahayvr/matteblack.nvim", colorscheme: "matteblack" },
  nord: { plugin: "EdenEast/nightfox.nvim", colorscheme: "nordfox" },
  "osaka-jade": { plugin: "ribru17/bamboo.nvim", colorscheme: "bamboo" },
  ristretto: { plugin: "gthelding/monokai-pro.nvim", colorscheme: "monokai-pro" },
  "rose-pine": { plugin: "rose-pine/neovim", colorscheme: "rose-pine-dawn" },
};

async function generatedNeovimConfig(slug: string): Promise<string> {
  const root = mkdtempSync(`${tmpdir()}/red-neovim-theme-`);
  process.env["HOME"] = root;
  mkdirSync(`${root}/.config/nvim`, { recursive: true });

  const theme = THEMES[slug];
  if (!theme) throw new Error(`missing fixture theme ${slug}`);
  expect(await applyNeovim(theme)).toBe(true);

  return readFileSync(`${root}/.config/nvim/lua/plugins/red-dev-theme.lua`, "utf8");
}

describe("neovim theme generation", () => {
  test("pins every theme to its colorscheme plugin and LazyVim colorscheme", async () => {
    expect(Object.keys(EXPECTED)).toEqual(Object.keys(THEMES));

    for (const [slug, spec] of Object.entries(EXPECTED)) {
      const lua = await generatedNeovimConfig(slug);
      expect(lua).toContain(`"${spec.plugin}"`);
      expect(lua).toContain(`colorscheme = "${spec.colorscheme}"`);
    }
  });

  test("only Tokyo Night generates a tokyonight reference", async () => {
    for (const slug of Object.keys(THEMES)) {
      const lua = await generatedNeovimConfig(slug);
      expect(lua.includes("tokyonight")).toBe(slug === "tokyo-night");
    }
  });
});
