import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { runBounded } from "./bounded-command.ts";

export interface StatuslineProbeResult {
  bounded: boolean;
  groupGone: boolean;
  exitCode: number | null;
}

/** Send a real Claude payload but deliberately keep stdin open. */
export async function probeOpenStdin(
  argv: string[],
  timeoutMs = 2_000,
): Promise<StatuslineProbeResult> {
  const result = await runBounded(argv, {
    stdin: JSON.stringify({
      cwd: process.cwd(),
      workspace: { project_dir: process.cwd(), current_dir: process.cwd() },
    }),
    keepStdinOpen: true,
    timeoutMs,
    killGraceMs: 250,
  });
  return {
    bounded: !result.timedOut && result.groupGone,
    groupGone: result.groupGone,
    exitCode: result.exitCode,
  };
}

export function latestDevBundle(home = process.env["HOME"] ?? homedir()): string | null {
  const override = process.env["RED_DEV_STATUSLINE_BUNDLE"];
  if (override && existsSync(override)) return override;
  const dir = `${home.replace(/\\/g, "/")}/.cache/red-skills/bundles`;
  try {
    const latest = readdirSync(dir)
      .filter((name) => /^dev-.*\.bundle\.min\.mjs$/.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .at(-1);
    return latest ? `${dir}/${latest}` : null;
  } catch {
    return null;
  }
}

export interface StatuslineHealth {
  legacyConfig: boolean;
  bundle: string | null;
  bounded: boolean | null;
  groupGone: boolean | null;
}

/** Inspect the local recipe and behaviour without starting redskilled. */
export async function inspectStatuslineHealth(
  cwd = process.cwd(),
  home = homedir(),
): Promise<StatuslineHealth> {
  let legacyConfig = false;
  let configuredCommand: string | null = null;
  const settings = `${cwd.replace(/\\/g, "/")}/.claude/settings.json`;
  if (existsSync(settings)) {
    try {
      const command = (JSON.parse(readFileSync(settings, "utf8")) as {
        statusLine?: { command?: unknown };
      }).statusLine?.command;
      configuredCommand = typeof command === "string" ? command : null;
      legacyConfig =
        typeof command === "string" &&
        (command.includes("--no-workers") || /redskilled.*statusline/.test(command));
    } catch {
      // A malformed settings file is configuration drift, not lifecycle evidence.
    }
  }

  const bundle = latestDevBundle(home);
  if (!bundle) return { legacyConfig, bundle: null, bounded: null, groupGone: null };
  if (!configuredCommand || !Bun.which("sh")) {
    return { legacyConfig, bundle, bounded: null, groupGone: null };
  }
  const probe = await probeOpenStdin(
    ["sh", "-c", configuredCommand],
    2_750,
  );
  return { legacyConfig, bundle, bounded: probe.bounded, groupGone: probe.groupGone };
}
