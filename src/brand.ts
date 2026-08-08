/**
 * The brand palette, read from the vendored source rather than retyped.
 *
 * `vendor/brand/tokens/tokens.json` is a byte-identical copy of the
 * canonical DTCG file; see the README beside it for why a copy. This
 * module is the only thing that parses it, and everything downstream
 * asks for a role by name.
 *
 * Two shapes live in that file and both have to be handled:
 *
 *   "500": { "$value": { "colorSpace": "srgb", "components": [...],
 *                        "hex": "#ff2056" } }
 *   "primary": { "$value": "{color.red.500}" }
 *
 * The second is an alias, and an alias may point at another alias. So
 * resolution is a loop with a cycle guard rather than one lookup — a
 * cycle in hand-authored JSON is a typo, not an impossibility, and one
 * would otherwise hang the process at import time.
 *
 * Imported with `type: "json"`, which red-dev already proves survives
 * `--compile` — src/cli.ts reads package.json the same way, and CI's
 * version-consistency step asserts the compiled binary reports it.
 */

import tokens from "../vendor/brand/tokens/tokens.json" with { type: "json" };

/** `#rrggbb`, lowercase, as the brand writes them. */
export type Hex = string;

type Node = Record<string, unknown>;

/** A DTCG dotted path: `color.neutral.950`, `color.brand.primary`. */
export type TokenPath = string;

function nodeAt(path: TokenPath): Node | undefined {
  let cursor: unknown = tokens;
  for (const part of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Node)[part];
  }
  return typeof cursor === "object" && cursor !== null ? (cursor as Node) : undefined;
}

/**
 * The hex for a token path, following aliases.
 *
 * Throws rather than returning a fallback. A missing token means the
 * vendored copy and this file disagree about what the brand contains,
 * and a silent `#000000` would ship that disagreement to a desktop.
 */
export function token(path: TokenPath): Hex {
  const seen = new Set<TokenPath>();
  let at = path;

  for (;;) {
    if (seen.has(at)) {
      throw new Error(`brand token ${path} resolves in a cycle through ${at}`);
    }
    seen.add(at);

    const node = nodeAt(at);
    const value = node?.["$value"];

    if (typeof value === "string") {
      const alias = /^\{(.+)\}$/.exec(value.trim())?.[1];
      if (!alias) throw new Error(`brand token ${at} is a string but not an alias: ${value}`);
      at = alias;
      continue;
    }

    if (typeof value === "object" && value !== null) {
      const hex = (value as Node)["hex"];
      if (typeof hex === "string") return hex.toLowerCase();
    }

    throw new Error(`brand token ${path} is not a colour (stopped at ${at})`);
  }
}

/**
 * The ramps, named the way the brand names them.
 *
 * Spelled out rather than generated from the file's keys so that a stop
 * disappearing upstream is a type error here rather than an undefined at
 * runtime. `neutral.0` is white and `neutral.950` is ink; the numbering
 * is the brand's, not a convention this repo chose.
 */
export const red = {
  400: token("color.red.400"),
  500: token("color.red.500"),
  600: token("color.red.600"),
  700: token("color.red.700"),
} as const;

export const neutral = {
  0: token("color.neutral.0"),
  50: token("color.neutral.50"),
  100: token("color.neutral.100"),
  200: token("color.neutral.200"),
  300: token("color.neutral.300"),
  400: token("color.neutral.400"),
  500: token("color.neutral.500"),
  600: token("color.neutral.600"),
  700: token("color.neutral.700"),
  800: token("color.neutral.800"),
  900: token("color.neutral.900"),
  950: token("color.neutral.950"),
} as const;

/** The semantic roles the brand publishes, resolved. */
export const brand = {
  primary: token("color.brand.primary"),
  hover: token("color.brand.hover"),
  active: token("color.brand.active"),
  onPrimary: token("color.brand.on-primary"),
  ink: token("color.ink"),
  paper: token("color.paper"),
} as const;

// ------------------------------------------------------- contrast

/** One sRGB channel, linearised. WCAG 2.x §relative luminance. */
function channel(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/**
 * The three channels of a brand colour, 0–255.
 *
 * Exported because Redwall paints with these rather than measuring them,
 * and a second hex parser written beside this one is a second place for
 * `#f4f5f7` to become something else.
 */
export function rgb(hex: Hex): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  return [
    Number.parseInt(m[1] as string, 16),
    Number.parseInt(m[2] as string, 16),
    Number.parseInt(m[3] as string, 16),
  ];
}

export function luminance(hex: Hex): number {
  const [r, g, b] = rgb(hex).map(channel) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG contrast ratio, 1 to 21.
 *
 * The same formula as the brand's scripts/audit-contrast.mjs, and
 * src/brand-guardrail.test.ts pins that agreement rather than assuming
 * it — a checker that drifts from the brand's would pass themes the
 * brand would fail.
 */
export function contrast(a: Hex, b: Hex): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m);
  return ((x as number) + 0.05) / ((y as number) + 0.05);
}

// ------------------------------------------------- guardrail data

export interface Guardrail {
  owner: TokenPath;
  relation: "normalText" | "asFill";
  /** The other side of the pair, as a token path. */
  against: TokenPath;
  /** What the brand declares the answer to be. */
  passes: boolean;
}

/**
 * Every contrast guardrail the vendored file declares.
 *
 * Read out of `$extensions.reddb.contrastGuardrail` rather than
 * transcribed, so the test that checks them cannot fall out of step with
 * the copy it is checking. `asFill` inverts the pair: the owner is the
 * background and the listed token is the text drawn on it.
 */
export function guardrails(): Guardrail[] {
  const out: Guardrail[] = [];

  const visit = (node: unknown, path: string): void => {
    if (typeof node !== "object" || node === null) return;
    const n = node as Node;

    const declared = (n["$extensions"] as Node | undefined)?.["reddb"] as Node | undefined;
    const rail = declared?.["contrastGuardrail"] as Node | undefined;
    if (rail) {
      const normal = rail["normalText"] as Node | undefined;
      for (const against of (normal?.["passesOn"] as string[]) ?? []) {
        out.push({ owner: path, relation: "normalText", against, passes: true });
      }
      for (const against of (normal?.["failsOn"] as string[]) ?? []) {
        out.push({ owner: path, relation: "normalText", against, passes: false });
      }
      const fill = rail["asFill"] as Node | undefined;
      for (const against of (fill?.["textPasses"] as string[]) ?? []) {
        out.push({ owner: path, relation: "asFill", against, passes: true });
      }
      for (const against of (fill?.["textFails"] as string[]) ?? []) {
        out.push({ owner: path, relation: "asFill", against, passes: false });
      }
    }

    for (const [key, child] of Object.entries(n)) {
      if (key.startsWith("$")) continue;
      visit(child, path ? `${path}.${key}` : key);
    }
  };

  visit(tokens, "");
  return out;
}
