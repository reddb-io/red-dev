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
};

export const DEFAULT_THEME = "tokyo-night";

export function themeNames(): string[] {
  return Object.keys(THEMES);
}
