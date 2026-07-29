/**
 * The fullscreen interface.
 *
 * The blocking prompts in ui.ts are the right tool for a wizard: ask,
 * get an answer, move on. They cannot do one thing this needs, though —
 * there is no hook for "the highlighted item changed", so a theme
 * cannot be previewed while you scroll past it. You would have to apply
 * a theme to find out what it looks like.
 *
 * So this is the reactive half of tuiuiu rather than the prompt half: a
 * render loop, signals, and a layout with a panel that reacts to the
 * selection. The prompts stay for `install`'s first run, where a linear
 * sequence of questions is exactly right and a fullscreen takeover
 * would be worse.
 *
 * Both halves are optional. Without a TTY neither runs, and every
 * command reachable here is reachable as a plain argument.
 */

import {
  Box,
  Text,
  render,
  useApp,
  useInput,
  useState,
  useTerminalSize,
} from "tuiuiu.js";
import type { Platform } from "./platform.ts";
import { summary } from "./platform.ts";
import { THEMES, themeNames } from "./themes.ts";

/**
 * A row of blocks in the palette's own colours.
 *
 * This is the whole reason for a fullscreen mode: seeing the colours
 * before committing to them. Background rather than foreground, because
 * a solid block reads as a swatch and a coloured glyph reads as text.
 */
function Swatches(hexes: string[]) {
  return Box(
    { flexDirection: "row" },
    ...hexes.map((hex) => Text({ backgroundColor: hex }, "    ")),
  );
}

interface Section {
  key: string;
  label: string;
  /** Shown in the right-hand panel while this section is highlighted. */
  notes: string[];
}

const SECTIONS: Section[] = [
  {
    key: "theme",
    label: "Theme",
    notes: [
      "One palette reaches eight surfaces:",
      "terminal, multiplexer, monitor, editor,",
      "VS Code, GNOME, and the wallpaper —",
      "which is generated from the palette,",
      "not shipped as a photograph.",
    ],
  },
  {
    key: "install",
    label: "Install",
    notes: [
      "Converge toward the manifest.",
      "Every provider is idempotent, so",
      "re-running after a failure is the",
      "normal recovery path rather than",
      "an edge case.",
    ],
  },
  {
    key: "doctor",
    label: "Doctor",
    notes: [
      "Presence on PATH is the easy half.",
      "This also compares deployed dotfiles",
      "byte-for-byte against the ones inside",
      "this binary, and asks Windows whether",
      "it can actually see the font.",
    ],
  },
  {
    key: "apps",
    label: "Apps",
    notes: [
      "Optional tools, never installed by a",
      "plain converge. Chosen, not assumed.",
    ],
  },
];

/** The palette in the order that reads best as a strip. */
function paletteOf(slug: string): string[] {
  const t = THEMES[slug];
  if (!t) return [];
  const c = t.terminal;
  return [c.background, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.foreground];
}

export interface TuiResult {
  /** Command the user chose to run after leaving the interface. */
  action: string | null;
  /** Theme they settled on, when they chose one. */
  theme?: string;
}

export async function runTui(p: Platform): Promise<TuiResult> {
  let result: TuiResult = { action: null };

  function App() {
    // exit() from useApp, never process.exit: the latter kills the
    // process before waitUntilExit resolves, so runTui would never
    // return and the chosen action would be lost.
    const { exit } = useApp();
    const size = useTerminalSize();
    // "sections" browses the left column; "themes" browses the palette
    // list, with the panel previewing whatever is highlighted.
    const [mode, setMode] = useState<"sections" | "themes">("sections");
    const [sectionIndex, setSectionIndex] = useState(0);
    const [themeIndex, setThemeIndex] = useState(0);

    const names = themeNames();

    useInput((input, key) => {
      const inThemes = mode() === "themes";
      const max = inThemes ? names.length - 1 : SECTIONS.length - 1;
      const index = inThemes ? themeIndex : sectionIndex;
      const setIndex = inThemes ? setThemeIndex : setSectionIndex;

      if (key.upArrow || input === "k") setIndex(Math.max(0, index() - 1));
      else if (key.downArrow || input === "j") setIndex(Math.min(max, index() + 1));
      else if (key.escape) {
        if (inThemes) setMode("sections");
        else result = { action: null };
      } else if (key.return) {
        if (inThemes) {
          result = { action: "theme", theme: names[themeIndex()] };
          exit();
        }
        const section = SECTIONS[sectionIndex()];
        if (section?.key === "theme") setMode("themes");
        else {
          result = { action: section?.key ?? null };
          exit();
        }
      } else if (input === "q") {
        result = { action: null };
        exit();
      }
    });

    const inThemes = mode() === "themes";
    const activeTheme = names[themeIndex()] ?? names[0]!;
    const section = SECTIONS[sectionIndex()];

    // Two columns, sized from the real terminal rather than assumed:
    // an 80-column window and a 200-column one should both look
    // deliberate.
    const width = Math.max(size.columns ?? 80, 60);
    const leftWidth = Math.max(22, Math.floor(width * 0.32));
    const rightWidth = width - leftWidth - 5;

    return Box(
      { flexDirection: "column", padding: 1 },

      // Header
      Box(
        { flexDirection: "row", justifyContent: "space-between", marginBottom: 1 },
        Text({ color: "red", bold: true }, "red-dev"),
        Text({ dim: true }, summary(p).split("\n")[0] ?? ""),
      ),

      Box(
        { flexDirection: "row" },

        // Left: the list being browsed
        Box(
          { flexDirection: "column", width: leftWidth, borderStyle: "round", padding: 1 },
          Text({ dim: true }, inThemes ? "THEME" : "SECTION"),
          ...(inThemes
            ? names.map((name, i) =>
                Text(
                  { color: i === themeIndex() ? "red" : undefined, bold: i === themeIndex() },
                  `${i === themeIndex() ? "❯ " : "  "}${name}`,
                ),
              )
            : SECTIONS.map((s, i) =>
                Text(
                  { color: i === sectionIndex() ? "red" : undefined, bold: i === sectionIndex() },
                  `${i === sectionIndex() ? "❯ " : "  "}${s.label}`,
                ),
              )),
        ),

        // Right: notes, or the live palette preview
        Box(
          { flexDirection: "column", width: rightWidth, borderStyle: "round", padding: 1, marginLeft: 1 },
          ...(inThemes
            ? [
                Text({ bold: true }, THEMES[activeTheme]?.name ?? activeTheme),
                Text({}, ""),
                Swatches(paletteOf(activeTheme)),
                Text({}, ""),
                Text({ dim: true }, "background · red · green · yellow"),
                Text({ dim: true }, "blue · magenta · cyan · foreground"),
                Text({}, ""),
                Text({ dim: true }, "Neovim colorscheme:"),
                Text({}, `  ${THEMES[activeTheme]?.neovim ?? "—"}`),
              ]
            : [
                Text({ bold: true }, section?.label ?? ""),
                Text({}, ""),
                ...(section?.notes ?? []).map((n) => Text({ dim: true }, n)),
              ]),
        ),
      ),

      // Footer
      Box(
        { marginTop: 1 },
        Text(
          { dim: true },
          inThemes
            ? "↑↓ preview · enter apply · esc back · q quit"
            : "↑↓ move · enter open · q quit",
        ),
      ),
    );
  }

  const { waitUntilExit } = render(App);
  await waitUntilExit();
  return result;
}
