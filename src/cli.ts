/**
 * Command-line surface, declared as a schema rather than parsed by
 * hand.
 *
 * The previous version did `const [, , cmd, arg] = process.argv`, which
 * cannot express an optional flag, cannot validate a scope against its
 * allowed values, and silently accepts nonsense. Declaring the shape
 * means unknown options and bad values are rejected before any provider
 * runs — the cheapest possible place to fail.
 */

import { createCLI, type CLI } from "cli-args-parser";
import pkg from "../package.json" with { type: "json" };
import { themeNames, DEFAULT_THEME } from "./themes.ts";

/**
 * One source of truth, inlined at build time.
 *
 * This was a hand-copied string, and package.json and the binary had
 * already drifted apart — 0.1.0 against 0.2.0 — with nothing to notice.
 * A release pipeline that checks the tag against a manifest the binary
 * does not read would have happily shipped the wrong number.
 */
export const VERSION: string = pkg.version;

const SCOPES = ["core", "desktop", "wsl", "optional"] as const;

/** Font keys accepted by --font; mirrors NERD_FONTS in wsl.ts. */
const FONTS = ["firacode", "jetbrainsmono", "hack", "caskaydiacove"] as const;

// PositionalDefinition has no `choices` field, so positional values are
// validated in parseArgs rather than by the schema. Declaring choices
// here would look like validation and do nothing — TypeScript only
// excess-property-checks inline literals, so it would not even warn.
const scopePositional = {
  name: "scope",
  description: `limit to one scope (${SCOPES.join(", ")})`,
  required: false,
} as const;

export function buildCli(): CLI {
  return createCLI({
    name: "red-dev",
    version: VERSION,
    description: "One dev environment across Ubuntu 24, Ubuntu 26, WSL and Windows",
    strict: true,
    options: {
      theme: {
        type: "string",
        description: "colour scheme to apply",
        choices: themeNames(),
        default: DEFAULT_THEME,
      },
      font: {
        type: "string",
        description: "Nerd Font to install (WSL and Windows targets)",
        choices: [...FONTS],
        default: "firacode",
      },
      opacity: {
        type: "number",
        description: "terminal background opacity, 0-100 (100 = opaque)",
        default: 90,
      },
    },
    commands: {
      platform: {
        description: "show what red-dev thinks this machine is",
      },
      plan: {
        description: "list what would change, change nothing",
        positional: [scopePositional],
      },
      install: {
        description: "converge this machine toward the manifest",
        positional: [scopePositional],
        options: {
          "dry-run": {
            type: "boolean",
            description: "print what install would do, then stop",
            default: false,
          },
          yes: {
            type: "boolean",
            description: "skip the first-run questions and take the defaults",
            default: false,
          },
        },
      },
      update: {
        description: "upgrade what the package managers own, then converge",
      },
      doctor: {
        description: "report drift against the manifest",
      },
      theme: {
        description: "apply a colour scheme",
        positional: [
          {
            name: "name",
            description: `theme to apply (${themeNames().join(", ")})`,
            required: false,
          },
        ],
      },
      apps: {
        description: "choose optional tools to install",
      },
      lang: {
        description: "choose language runtimes for mise to manage",
      },
      shell: {
        description: "choose whether the terminal opens WSL or Git Bash",
      },
      uninstall: {
        description: "remove tools or red-dev's own configuration",
      },
      wsl: {
        description: "set up WSL on this Windows machine",
      },
      ui: {
        description: "fullscreen interface, with live theme preview",
      },
      menu: {
        description: "interactive menu",
      },
    },
  });
}

export interface Invocation {
  command: string | null;
  scope: string | undefined;
  themeName: string;
  font: string;
  opacity: number;
  dryRun: boolean;
  /** --yes: take defaults instead of asking on a first run. */
  yes: boolean;
  /**
   * Parse and validation failures. Strict mode means an unrecognised
   * command lands here too, with the list of real ones — so there is no
   * separate "unknown verb" channel to check.
   */
  errors: string[];
}

/**
 * The schema coerces to a number but does not range-check, and an
 * out-of-range opacity is silently ignored by Windows Terminal — the
 * worst outcome, because the user sees no error and no effect.
 */
function clampOpacity(raw: unknown, errors: string[]): number {
  if (typeof raw !== "number" || Number.isNaN(raw)) return 90;
  if (raw < 0 || raw > 100) {
    errors.push(`opacity must be between 0 and 100 (got ${raw})`);
    return 90;
  }
  return Math.round(raw);
}

export function parseArgs(cli: CLI, argv: string[]): Invocation {
  const r = cli.parse(argv);
  const opts = r.options as Record<string, unknown>;
  const pos = r.positional as Record<string, unknown>;
  const errors = [...(r.errors ?? [])];

  // Positionals carry no schema-level choices, so check them here.
  const rawScope = pos["scope"];
  let scope: string | undefined;
  if (typeof rawScope === "string") {
    if ((SCOPES as readonly string[]).includes(rawScope)) {
      scope = rawScope;
    } else {
      errors.push(`invalid scope '${rawScope}' (expected: ${SCOPES.join(", ")})`);
    }
  }

  const rawName = pos["name"];
  if (typeof rawName === "string" && !themeNames().includes(rawName)) {
    errors.push(`unknown theme '${rawName}' (known: ${themeNames().join(", ")})`);
  }

  return {
    command: r.command[0] ?? null,
    // `theme <name>` and `plan <scope>` both land in the positional map
    // under their own key; the caller reads whichever applies.
    scope: scope ?? (typeof rawName === "string" ? rawName : undefined),
    themeName: typeof opts["theme"] === "string" ? opts["theme"] : DEFAULT_THEME,
    font: typeof opts["font"] === "string" ? opts["font"] : "firacode",
    opacity: clampOpacity(opts["opacity"], errors),
    dryRun: opts["dry-run"] === true,
    yes: opts["yes"] === true,
    errors,
  };
}
