/**
 * Colour schemes, defined once and applied to every surface that can
 * take them: the Windows Terminal on Windows and WSL, Alacritty on the
 * desktop, and Neovim everywhere.
 *
 * A theme is data, not a script. Omakub keeps one theme per directory
 * with a file per application; the shape here is the same idea reduced
 * to a record, because the set of applications is fixed and small.
 */

export interface TerminalPalette {
  background: string;
  foreground: string;
  cursorColor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  purple: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightPurple: string;
  brightCyan: string;
  brightWhite: string;
}

export interface Theme {
  name: string;
  /** Neovim colorscheme name, for the LazyVim config. */
  neovim: string;
  terminal: TerminalPalette;
}

export const THEMES: Record<string, Theme> = {
  "tokyo-night": {
    name: "Tokyo Night",
    neovim: "tokyonight",
    terminal: {
      background: "#1A1B26",
      foreground: "#A9B1D6",
      cursorColor: "#C0CAF5",
      selectionBackground: "#283457",
      black: "#15161E",
      red: "#F7768E",
      green: "#9ECE6A",
      yellow: "#E0AF68",
      blue: "#7AA2F7",
      purple: "#BB9AF7",
      cyan: "#7DCFFF",
      white: "#A9B1D6",
      brightBlack: "#414868",
      brightRed: "#F7768E",
      brightGreen: "#9ECE6A",
      brightYellow: "#E0AF68",
      brightBlue: "#7AA2F7",
      brightPurple: "#BB9AF7",
      brightCyan: "#7DCFFF",
      brightWhite: "#C0CAF5",
    },
  },

  catppuccin: {
    name: "Catppuccin Macchiato",
    neovim: "catppuccin-macchiato",
    terminal: {
      background: "#24273A",
      foreground: "#CAD3F5",
      cursorColor: "#F4DBD6",
      selectionBackground: "#3A3E52",
      black: "#494D64",
      red: "#ED8796",
      green: "#A6DA95",
      yellow: "#EED49F",
      blue: "#8AADF4",
      purple: "#F5BDE6",
      cyan: "#8BD5CA",
      white: "#B8C0E0",
      brightBlack: "#5B6078",
      brightRed: "#ED8796",
      brightGreen: "#A6DA95",
      brightYellow: "#EED49F",
      brightBlue: "#8AADF4",
      brightPurple: "#F5BDE6",
      brightCyan: "#8BD5CA",
      brightWhite: "#A5ADCB",
    },
  },

  gruvbox: {
    name: "Gruvbox Dark",
    neovim: "gruvbox",
    terminal: {
      background: "#282828",
      foreground: "#EBDBB2",
      cursorColor: "#EBDBB2",
      selectionBackground: "#504945",
      black: "#282828",
      red: "#CC241D",
      green: "#98971A",
      yellow: "#D79921",
      blue: "#458588",
      purple: "#B16286",
      cyan: "#689D6A",
      white: "#A89984",
      brightBlack: "#928374",
      brightRed: "#FB4934",
      brightGreen: "#B8BB26",
      brightYellow: "#FABD2F",
      brightBlue: "#83A598",
      brightPurple: "#D3869B",
      brightCyan: "#8EC07C",
      brightWhite: "#EBDBB2",
    },
  },

  // Palettes taken from omakub's own alacritty.toml for each theme,
  // generated rather than transcribed: 112 hex values copied by hand is
  // a guaranteed typo, and a wrong one is invisible until someone
  // notices their terminal's blue is slightly off.
  "everforest": {
    name: "Everforest",
    neovim: "everforest",
    terminal: {
      background: "#2D353B",
      foreground: "#D3C6AA",
      cursorColor: "#D3C6AA",
      selectionBackground: "#2D353B",
      black: "#475258",
      red: "#E67E80",
      green: "#A7C080",
      yellow: "#DBBC7F",
      blue: "#7FBBB3",
      purple: "#D699B6",
      cyan: "#83C092",
      white: "#D3C6AA",
      brightBlack: "#475258",
      brightRed: "#E67E80",
      brightGreen: "#A7C080",
      brightYellow: "#DBBC7F",
      brightBlue: "#7FBBB3",
      brightPurple: "#D699B6",
      brightCyan: "#83C092",
      brightWhite: "#D3C6AA",
    },
  },
  "kanagawa": {
    name: "Kanagawa",
    neovim: "kanagawa",
    terminal: {
      background: "#1F1F28",
      foreground: "#DCD7BA",
      cursorColor: "#DCD7BA",
      selectionBackground: "#2D4F67",
      black: "#090618",
      red: "#C34043",
      green: "#76946A",
      yellow: "#C0A36E",
      blue: "#7E9CD8",
      purple: "#957FB8",
      cyan: "#6A9589",
      white: "#C8C093",
      brightBlack: "#727169",
      brightRed: "#E82424",
      brightGreen: "#98BB6C",
      brightYellow: "#E6C384",
      brightBlue: "#7FB4CA",
      brightPurple: "#938AA9",
      brightCyan: "#7AA89F",
      brightWhite: "#DCD7BA",
    },
  },
  "matte-black": {
    name: "Matte Black",
    neovim: "matteblack",
    terminal: {
      background: "#121212",
      foreground: "#BEBEBE",
      cursorColor: "#EAEAEA",
      selectionBackground: "#333333",
      black: "#333333",
      red: "#D35F5F",
      green: "#FFC107",
      yellow: "#B91C1C",
      blue: "#E68E0D",
      purple: "#D35F5F",
      cyan: "#BEBEBE",
      white: "#BEBEBE",
      brightBlack: "#8A8A8D",
      brightRed: "#B91C1C",
      brightGreen: "#FFC107",
      brightYellow: "#B90A0A",
      brightBlue: "#F59E0B",
      brightPurple: "#B91C1C",
      brightCyan: "#EAEAEA",
      brightWhite: "#FFFFFF",
    },
  },
  "nord": {
    name: "Nord",
    neovim: "nordfox",
    terminal: {
      background: "#2E3440",
      foreground: "#D8DEE9",
      cursorColor: "#D8DEE9",
      selectionBackground: "#4C566A",
      black: "#3B4252",
      red: "#BF616A",
      green: "#A3BE8C",
      yellow: "#EBCB8B",
      blue: "#81A1C1",
      purple: "#B48EAD",
      cyan: "#88C0D0",
      white: "#E5E9F0",
      brightBlack: "#4C566A",
      brightRed: "#BF616A",
      brightGreen: "#A3BE8C",
      brightYellow: "#EBCB8B",
      brightBlue: "#81A1C1",
      brightPurple: "#B48EAD",
      brightCyan: "#8FBCBB",
      brightWhite: "#ECEFF4",
    },
  },
  "osaka-jade": {
    name: "Osaka Jade",
    neovim: "bamboo",
    terminal: {
      background: "#111C18",
      foreground: "#C1C497",
      cursorColor: "#D7C995",
      selectionBackground: "#23372B",
      black: "#23372B",
      red: "#FF5345",
      green: "#549E6A",
      yellow: "#459451",
      blue: "#509475",
      purple: "#D2689C",
      cyan: "#2DD5B7",
      white: "#F6F5DD",
      brightBlack: "#53685B",
      brightRed: "#DB9F9C",
      brightGreen: "#63B07A",
      brightYellow: "#E5C736",
      brightBlue: "#ACD4CF",
      brightPurple: "#75BBB3",
      brightCyan: "#8CD3CB",
      brightWhite: "#9EEBB3",
    },
  },
  "ristretto": {
    name: "Ristretto",
    neovim: "monokai-pro",
    terminal: {
      background: "#2C2525",
      foreground: "#E6D9DB",
      cursorColor: "#C3B7B8",
      selectionBackground: "#403E41",
      black: "#2C2525",
      red: "#FD6883",
      green: "#ADDA78",
      yellow: "#F9CC6C",
      blue: "#F38D70",
      purple: "#A8A9EB",
      cyan: "#85DACC",
      white: "#E6D9DB",
      brightBlack: "#463A3A",
      brightRed: "#FF8297",
      brightGreen: "#C8E292",
      brightYellow: "#FCD675",
      brightBlue: "#F8A788",
      brightPurple: "#BEBFFD",
      brightCyan: "#9BF1E1",
      brightWhite: "#F1E5E7",
    },
  },
  "rose-pine": {
    name: "Rose Pine",
    neovim: "rose-pine-dawn",
    terminal: {
      background: "#FAF4ED",
      foreground: "#575279",
      cursorColor: "#CECACD",
      selectionBackground: "#DFDAD9",
      black: "#F2E9E1",
      red: "#B4637A",
      green: "#286983",
      yellow: "#EA9D34",
      blue: "#56949F",
      purple: "#907AA9",
      cyan: "#D7827E",
      white: "#575279",
      brightBlack: "#9893A5",
      brightRed: "#B4637A",
      brightGreen: "#286983",
      brightYellow: "#EA9D34",
      brightBlue: "#56949F",
      brightPurple: "#907AA9",
      brightCyan: "#D7827E",
      brightWhite: "#575279",
    },
  },
};

export const DEFAULT_THEME = "tokyo-night";

export function themeNames(): string[] {
  return Object.keys(THEMES);
}
