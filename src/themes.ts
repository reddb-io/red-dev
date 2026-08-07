/**
 * The six RedDB themes.
 *
 * These replace ten palettes transcribed from omakub, which were chosen
 * before this project had a brand to be. They are built from
 * `vendor/brand/tokens/tokens.json` — no hex literal appears in this
 * file, because a hex here would be a second source of truth waiting to
 * disagree with the first.
 *
 * ## What a theme is now, and what it stopped being
 *
 * A theme used to carry a twenty-value ANSI palette, and that palette
 * was its only colour data: the Windows accent and the wallpaper both
 * derived from it. .red/adr/0002 reversed that. Everything inside a
 * terminal window now takes one fixed palette that never varies, because
 * every program in there paints over the ANSI slots beneath it and a
 * theme spread across a dozen of them arrived as neither the old one nor
 * the new one.
 *
 * So a theme is the desktop: the wallpaper, the system accent and
 * light-dark, and the editor that is a window rather than a pane. The
 * roles below are what those surfaces need, and nothing more.
 *
 * ## Contrast is enforced, not intended
 *
 * src/theme-contrast.test.ts measures every role pair in every theme
 * against the brand's own published guardrails. A theme that puts
 * red.500 text on neutral.800 fails arithmetic rather than review.
 */

import { neutral, red, type Hex } from "./brand.ts";

export type { Hex };

export const THEME_SLUGS = ["dark", "light", "obsidian", "marble", "cobalt", "flare"] as const;
export type ThemeSlug = (typeof THEME_SLUGS)[number];

/** Grounds, in depth order. Every value is a brand neutral or a brand red. */
export interface ThemeSurface {
  /** The deepest ground: the desktop, the wallpaper's base. */
  bg: Hex;
  /** One step up: panels, cards. */
  panel: Hex;
  /** Most raised: hovered rows, chips. */
  raised: Hex;
  /** Hairlines. Read only when hunted for. */
  edge: Hex;
}

export interface ThemeText {
  /** Body copy. Measured at 4.5 on both `bg` and `panel`. */
  normal: Hex;
  /** Headings — the line carrying the answer. Measured at 7 on `bg`. */
  strong: Hex;
  /**
   * Labels and units. Measured at 3, not 4.5, and deliberately: the
   * brand's own dark mapping uses neutral.500, which its own guardrail
   * declares as failing 4.5 on every dark ground. This is the secondary
   * bar, and calling it 4.5 would either fail the brand's own palette or
   * quietly push muted text up until it stops reading as muted.
   */
  muted: Hex;
}

/** GNOME 47+ takes a name from a fixed list, never a hex. */
export type GnomeAccent =
  | "blue" | "teal" | "green" | "yellow"
  | "orange" | "red" | "pink" | "purple" | "slate";

/**
 * The accent, or its deliberate absence.
 *
 * obsidian and marble have none — that is what they are for — and a
 * theme reporting #ff2056 it never uses would paint the title bar of the
 * one theme chosen to have no red. `kind` is the discriminant so each
 * surface renders absence in its own vocabulary: GNOME gets `slate`,
 * Windows gets a neutral accent with prevalence off, the swatch strip
 * gets one cell fewer.
 *
 * `value` is always a FILL and never text. There is no accent-as-text
 * role in this type, because red.500 fails as normal text on every
 * ground lighter than neutral.900 and a role that cannot be used safely
 * should not exist to be reached for.
 */
export type ThemeAccent =
  | {
      kind: "colour";
      /** The fill: the Windows accent, the wallpaper's lift. */
      value: Hex;
      /** Text drawn on that fill. Measured at 4.5 against `value`. */
      on: Hex;
      gnome: GnomeAccent;
    }
  | { kind: "none" };

export interface Theme {
  /** Display name, e.g. "RedDB Dark". */
  name: string;
  /** One line for the TUI, where the Neovim colorscheme used to sit. */
  blurb: string;
  appearance: "light" | "dark";
  surface: ThemeSurface;
  text: ThemeText;
  accent: ThemeAccent;
  /**
   * A VS Code *built-in* theme name.
   *
   * There is no published RedDB VS Code theme, so the honest maximum is
   * light or dark. That is a real reduction — a theme drives VS Code's
   * appearance and nothing more — and it buys something large: the
   * marketplace install path leaves the theme hot path entirely, along
   * with the `code.cmd` quoting bug and the one theme that had no
   * extension to install.
   */
  vscode: string;
}

/** The accent every accented theme uses, since there is only one. */
const ACCENT: ThemeAccent = {
  kind: "colour",
  value: red[500],
  // The black R on the red field — color.brand.on-primary. Not white:
  // white on the accent measures 3.75 and the brand's own guardrail
  // declares it a failure.
  on: neutral[950],
  gnome: "red",
};

const NO_ACCENT: ThemeAccent = { kind: "none" };

export const THEMES: Record<ThemeSlug, Theme> = {
  dark: {
    name: "RedDB Dark",
    blurb: "ink, paper and the accent — the brand as it is written",
    appearance: "dark",
    surface: { bg: neutral[950], panel: neutral[900], raised: neutral[800], edge: neutral[700] },
    text: { normal: neutral[300], strong: neutral[50], muted: neutral[500] },
    accent: ACCENT,
    vscode: "Default Dark Modern",
  },

  light: {
    name: "RedDB Light",
    blurb: "the same argument on paper — support, not parity",
    appearance: "light",
    surface: { bg: neutral[50], panel: neutral[100], raised: neutral[0], edge: neutral[200] },
    text: { normal: neutral[700], strong: neutral[950], muted: neutral[500] },
    accent: ACCENT,
    vscode: "Default Light Modern",
  },

  obsidian: {
    // The brand test hiding inside a colour question, and the one the
    // brand already ran: wallpaper 26 exists to argue that RedDB still
    // reads as RedDB with the accent removed. If it does, the identity
    // is carried by the cut and the type; if not, the brand is the
    // colour and everything else is packaging.
    name: "Obsidian",
    blurb: "the dark with the accent removed entirely",
    appearance: "dark",
    surface: { bg: neutral[950], panel: neutral[900], raised: neutral[800], edge: neutral[700] },
    // Paper rather than neutral.50 for the strong line: with no accent,
    // the hierarchy is the only thing left doing the work.
    text: { normal: neutral[300], strong: neutral[0], muted: neutral[500] },
    accent: NO_ACCENT,
    vscode: "Default Dark Modern",
  },

  marble: {
    name: "Marble",
    blurb: "obsidian's opposite: light, and just as quiet",
    appearance: "light",
    // raised sits *below* panel on the ramp here, which is not a
    // mistake: on a light ground, raising something means moving it
    // toward white, and panel is already white.
    surface: { bg: neutral[50], panel: neutral[0], raised: neutral[100], edge: neutral[200] },
    text: { normal: neutral[700], strong: neutral[950], muted: neutral[500] },
    accent: NO_ACCENT,
    vscode: "Default Light Modern",
  },

  cobalt: {
    name: "Cobalt",
    blurb: "a grey ground, many greys, and the accent back",
    appearance: "dark",
    // The only theme whose ground is neither ink nor paper. Four grey
    // steps distributed rather than two, which is the point of it.
    surface: { bg: neutral[700], panel: neutral[800], raised: neutral[600], edge: neutral[500] },
    text: { normal: neutral[100], strong: neutral[0], muted: neutral[300] },
    // The accent measures 3.07 against this ground — above the non-text
    // floor and below the text one. It is a fill here and nowhere near
    // a letterform, which the type already guarantees.
    accent: ACCENT,
    vscode: "Default Dark Modern",
  },

  flare: {
    name: "Flare",
    blurb: "the accent as the surface, spent all at once",
    appearance: "dark",
    // Everywhere else the red earns attention by scarcity. Here the
    // panels *are* red, three tones of it, against an ink ground.
    surface: { bg: neutral[950], panel: red[700], raised: red[600], edge: red[500] },
    text: { normal: neutral[50], strong: neutral[0], muted: neutral[300] },
    accent: ACCENT,
    vscode: "Default Dark Modern",
  },
};

export const DEFAULT_THEME: ThemeSlug = "dark";

export function themeNames(): ThemeSlug[] {
  return [...THEME_SLUGS];
}

export function isThemeSlug(s: string): s is ThemeSlug {
  return (THEME_SLUGS as readonly string[]).includes(s);
}

/**
 * A theme by slug, for the callers holding a string.
 *
 * THEMES is `Record<ThemeSlug, Theme>` rather than `Record<string,
 * Theme>` on purpose: it makes every slug-indexed map exhaustive at
 * compile time, which is how the six stay in step with the maps that
 * key on them. The cost is that a plain string cannot index it, and
 * this is the one place that narrowing happens.
 */
export function themeFor(slug: string): Theme | undefined {
  return isThemeSlug(slug) ? THEMES[slug] : undefined;
}

// ------------------------------------------------------- retirement

/**
 * The ten that are gone, and what each becomes.
 *
 * Every machine red-dev has ever touched has one of these recorded in
 * its preferences. Without a mapping, the next converge reads a slug
 * that no longer exists — and the interesting question is not whether to
 * handle that but *where*: `resolveThemeSlug` heals it on read, with no
 * write and no ledger, so it is idempotent by construction and correct
 * even on a preferences file restored from a backup.
 *
 * One rule, no taste in it: every retired dark palette lands on `dark`
 * and the one light palette on `light`. matte-black has an argument for
 * obsidian on the name alone, but it carried a red accent, and picking
 * by vibe is how a mapping becomes ten separate opinions.
 */
export const RETIRED_THEMES: Record<string, ThemeSlug> = {
  "tokyo-night": "dark",
  catppuccin: "dark",
  gruvbox: "dark",
  everforest: "dark",
  kanagawa: "dark",
  "matte-black": "dark",
  nord: "dark",
  "osaka-jade": "dark",
  ristretto: "dark",
  "rose-pine": "light",
};

/**
 * A live slug for whatever was recorded.
 *
 * Deliberately NOT used by the CLI parser. An explicit `--theme
 * tokyo-night` should fail loudly with the six live names, because it is
 * a command someone typed; a stale recorded preference should heal
 * quietly, because it is a fact about the past. Different inputs, and
 * treating them the same would either nag about history or silently
 * accept a typo.
 */
export function resolveThemeSlug(s: string | undefined): ThemeSlug {
  if (s && isThemeSlug(s)) return s;
  if (s && RETIRED_THEMES[s]) return RETIRED_THEMES[s];
  return DEFAULT_THEME;
}

// ---------------------------------------------------------- preview

/**
 * The strip the TUI draws: the ground ramp, then the accent when there
 * is one.
 *
 * Seven cells or eight, and the difference is the feature. The absence
 * of an accent is the single most important thing about obsidian and
 * marble, and this is the only place anyone sees it before choosing.
 * Padding to a fixed eight would make the type honest and the interface
 * lie.
 *
 * One function where there were four copies of `paletteOf`, each
 * reaching into a terminal palette that no longer varies.
 */
export function swatches(slug: string): Hex[] {
  const t = THEMES[slug as ThemeSlug];
  if (!t) return [];
  const ramp = [
    t.surface.bg,
    t.surface.panel,
    t.surface.raised,
    t.surface.edge,
    t.text.muted,
    t.text.normal,
    t.text.strong,
  ];
  return t.accent.kind === "colour" ? [...ramp, t.accent.value] : ramp;
}
