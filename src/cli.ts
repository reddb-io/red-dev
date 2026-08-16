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
import { isThemeSlug, themeNames, DEFAULT_THEME } from "./themes.ts";

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
      privileged: {
        // No positional and no flags, for the same reason `redwall` has
        // none: what it does is settled by the manifest and by what this
        // machine is still missing, so there is nothing here for the
        // caller to decide. It is the command a deferred converge points
        // at, and a command named in a remedy has to be typeable exactly
        // as it was printed.
        description: "finish only the work that needs administrator",
      },
      doctor: {
        description: "report drift against the manifest",
      },
      statusline: {
        description: "render the bounded Claude status line",
      },
      rescue: {
        description: "inspect or end process groups proven to be orphaned",
        options: {
          apply: {
            type: "boolean",
            description: "write a forensic snapshot and apply the displayed rescue plan",
            default: false,
          },
          yes: {
            type: "boolean",
            description: "confirm an apply in a non-interactive session",
            default: false,
          },
        },
      },
      reclaim: {
        description: "inspect or prune derived logs and crash artifacts",
        options: {
          apply: {
            type: "boolean",
            description: "apply the displayed retention plan",
            default: false,
          },
          yes: {
            type: "boolean",
            description: "confirm an apply in a non-interactive session",
            default: false,
          },
          "crash-dumps": {
            type: "boolean",
            description: "include Windows CrashDumps in the explicit reclaim",
            default: false,
          },
        },
      },
      logs: {
        description: "show the last run's transcript",
        positional: [
          {
            name: "which",
            description: "'list' for every kept run, or a number: 2 is the run before last",
            required: false,
          },
        ],
      },
      wallpaper: {
        description: "choose bundled art or import a PNG independently from the colour theme",
        positional: [
          {
            name: "wallpaper_name",
            description:
              `theme, ${themeNames().join(", ")}, or an absolute PNG path/HTTPS URL`,
            required: false,
          },
        ],
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
      redwall: {
        // No positional, and no flag to force it on. What it draws comes
        // from the machine and whether it draws at all comes from the
        // preference, so there is nothing here for a caller to decide —
        // which is what lets a hook invoke it with no arguments and no
        // knowledge of how the feature is configured.
        description: "regenerate the wallpaper that carries this machine's state",
      },
      apps: {
        description: "choose optional tools and web apps; untick an installed one to remove it",
      },
      keys: {
        // No positional and no flags. What it lists comes from the
        // action registry and what it says about each row comes from
        // this machine, so there is nothing here for a caller to decide
        // — and the search is typed into the viewer, not onto the
        // command line, because the point of the thing is to find a
        // chord you cannot name yet.
        description: "search every action and its chord, and run one",
      },
      learn: {
        description: "the README by anchor, RedSkills, and the keys viewer",
      },
      agents: {
        description:
          "choose coding agents, wire red-skills into them, or `update` each by its publisher's mechanism",
        // Two positionals of its own, for the reason `share adopt
        // <tool>` has two: a comma-separated selection and a
        // subcommand's single argument are different shapes, and one
        // positional would swallow only the first word of
        // `agents default claude-code`.
        positional: [
          {
            name: "agent_selection",
            description:
              "comma-separated agent keys for an unattended install, or `default`, `run`, `update`",
            required: false,
          },
          {
            name: "agent_key",
            description: "with `default`: the one host red-dev hands work to",
            required: false,
          },
        ],
      },
      lang: {
        description: "choose language runtimes for mise to manage",
        options: {
          latest: {
            type: "boolean",
            description: "install the newest release of every selected runtime",
            default: false,
          },
        },
        positional: [
          {
            name: "runtime_selection",
            description: "comma-separated runtime ids for an unattended install",
            required: false,
          },
        ],
      },
      shell: {
        description: "choose whether the terminal opens WSL or Git Bash",
      },
      ssh: {
        description: "authorize a GitHub account's published public keys on this machine",
        positional: [
          {
            name: "github_user",
            description: "the GitHub account whose keys to fetch, show and authorize",
            required: false,
          },
        ],
        options: {
          // The keys are still fetched and still printed; what this
          // skips is the question, which is the only part a pipeline
          // cannot answer. Declared here rather than borrowed from
          // `install`, because an option that exists on every command is
          // an option nobody reads before typing.
          yes: {
            type: "boolean",
            description: "authorize without asking — the keys are printed either way",
            default: false,
          },
        },
      },
      share: {
        description: "one directory both WSL and Windows read configuration from",
        // Two positionals with names of their own, and both halves of
        // that mattered. One would have swallowed only the first word of
        // `share adopt zellij`, and reusing `scope` would have rejected
        // `adopt` as an invalid scope — a confusing way to learn that a
        // subcommand exists.
        positional: [
          {
            name: "target",
            description: "a Windows path to set the root, or `adopt`",
            required: false,
          },
          {
            name: "tool",
            description: "with `adopt`: which tool's configuration to move in",
            required: false,
          },
        ],
      },
      uninstall: {
        description: "remove tools or red-dev's own configuration",
      },
      wsl: {
        description: "set up or verify WSL 2 on this Windows machine",
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
  /** Rescue/Reclaim remain previews until this is explicitly true. */
  apply: boolean;
  /** Reclaim only touches Windows CrashDumps when explicitly selected. */
  crashDumps: boolean;
  /** --yes: take defaults instead of asking on a first run. */
  yes: boolean;
  /** `share <target> [tool]` — its own positionals, see the note in buildCli. */
  shareTarget: string | undefined;
  shareTool: string | undefined;
  /**
   * `logs [which]` — its own positional, for the same reason share has
   * two of its own. Reusing `scope` would reject `list` as an invalid
   * scope, and reusing `name` would reject it as an unknown theme.
   */
  logsWhich: string | undefined;
  /** Explicit selections make agents/lang safe to invoke across WSL unattended. */
  agentKeys: string[] | undefined;
  /**
   * `agents default [key]` — naming the subcommand and naming a host
   * are separate facts, because with no key the command reports the
   * recorded choice rather than changing it.
   */
  agentDefault: boolean;
  agentDefaultKey: string | undefined;
  /** `agents run` — start the Default agent. */
  agentRun: boolean;
  /** `agents update` — refresh every installed host, each its own way. */
  agentUpdate: boolean;
  /**
   * Everything after `--`: arguments for the program red-dev starts,
   * not for red-dev. Kept verbatim, including flags red-dev would never
   * add itself — see src/agent-launch.ts.
   */
  passthrough: string[];
  runtimeIds: string[] | undefined;
  /** `lang --latest`: rewrite every selected runtime selector to `latest`. */
  latest: boolean;
  /** `wallpaper [theme|slug|absolute-path|https-url]` — absent opens the picker. */
  wallpaperName: string | undefined;
  /**
   * `ssh [github-user]` — its own positional, because the account name
   * is neither a scope nor a theme and reusing either would reject it
   * with a list of the wrong words.
   */
  sshUser: string | undefined;
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
  // `--` ends red-dev's own arguments. What follows belongs to the
  // program red-dev is about to start, and must never reach the schema
  // — strict mode would reject `--dangerously-skip-permissions` as an
  // unknown option, when it is not an option of ours at all.
  const separator = argv.indexOf("--");
  const passthrough = separator >= 0 ? argv.slice(separator + 1) : [];
  const r = cli.parse(separator >= 0 ? argv.slice(0, separator) : argv);
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
  if (typeof rawName === "string" && !isThemeSlug(rawName)) {
    errors.push(`unknown theme '${rawName}' (known: ${themeNames().join(", ")})`);
  }

  // cli-args-parser treats a Windows drive prefix (`C:`) as metadata and
  // silently removes the positional. Recover the literal argv token for
  // this command; paths and signed HTTPS URLs must arrive byte-for-byte.
  const wallpaperCommand = argv.indexOf("wallpaper");
  const literalWallpaper = wallpaperCommand >= 0 ? argv[wallpaperCommand + 1] : undefined;
  const rawWallpaper = pos["wallpaper_name"] ??
    (literalWallpaper && !literalWallpaper.startsWith("-") ? literalWallpaper : undefined);

  // `default`, `run` and `update` in the selection slot are
  // subcommands, not agent keys — no agent is called any of them
  // either, and reading one as a key would try to install it and fail
  // with a list of the real names.
  const rawAgents = pos["agent_selection"];
  const agentDefault = rawAgents === "default";
  const agentRun = rawAgents === "run";
  const agentUpdate = rawAgents === "update";
  return {
    command: r.command[0] ?? null,
    // `theme <name>` and `plan <scope>` both land in the positional map
    // under their own key; the caller reads whichever applies.
    scope: scope ?? (typeof rawName === "string" ? rawName : undefined),
    logsWhich: typeof pos["which"] === "string" ? pos["which"] : undefined,
    agentKeys:
      typeof rawAgents === "string" && !agentDefault && !agentRun && !agentUpdate
        ? rawAgents.split(",").map((value) => value.trim()).filter(Boolean)
        : undefined,
    agentDefault,
    agentDefaultKey:
      agentDefault && typeof pos["agent_key"] === "string" ? pos["agent_key"] : undefined,
    agentRun,
    agentUpdate,
    passthrough,
    runtimeIds:
      typeof pos["runtime_selection"] === "string"
        ? pos["runtime_selection"].split(",").map((value) => value.trim()).filter(Boolean)
        : undefined,
    latest: opts["latest"] === true,
    wallpaperName: typeof rawWallpaper === "string" ? rawWallpaper : undefined,
    sshUser: typeof pos["github_user"] === "string" ? pos["github_user"] : undefined,
    themeName: typeof opts["theme"] === "string" ? opts["theme"] : DEFAULT_THEME,
    font: typeof opts["font"] === "string" ? opts["font"] : "firacode",
    opacity: clampOpacity(opts["opacity"], errors),
    dryRun: opts["dry-run"] === true,
    apply: opts["apply"] === true,
    crashDumps: opts["crash-dumps"] === true,
    yes: opts["yes"] === true,
    shareTarget: typeof pos["target"] === "string" ? pos["target"] : undefined,
    shareTool: typeof pos["tool"] === "string" ? pos["tool"] : undefined,
    errors,
  };
}
