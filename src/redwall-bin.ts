/**
 * Render Redwall through a scriptc-compiled binary, when one is available.
 *
 * Why this exists: `renderRedwall` in `redwall-render.ts` ships inside the
 * Bun-compiled `red-dev` binary, which is 82 MB because it embeds the Bun
 * runtime. A standalone scriptc build of the renderer is 1.8 MB with a
 * 4 MB RSS, and produces byte-identical PNGs. The trade is a separate
 * binary to install and a process to fork on every repaint — both cheap.
 *
 * The bin path is read once per call (cheap stat). A `null` here means
 * "no scriptc build, fall back to the in-process renderer"; a failure
 * during exec also falls through, so a red-dev that ships without one
 * still works.
 *
 * State crosses the process boundary as environment variables: integers
 * stay integers, strings stay strings, the absent stays absent. The
 * binary reads them in `main.ts` and writes the PNG to stdout, which is
 * piped back into the caller's buffer.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { runBounded, type BoundedCommandOptions } from "./bounded-command.ts";
import { THEMES } from "./themes.ts";

/** The env var that overrides the auto-detected bin path. */
const ENV_OVERRIDE = "REDWALL_BIN";

/** Where the bundler puts the scriptc build under vendor/. */
const VENDOR_RELATIVE = "vendor/redwall-bin/redwall";

function resolveVendorBin(): string | null {
  // Sibling to the running red-dev binary — the normal install puts both
  // bins in the same directory (boot.sh writes them next to each other
  // under ~/.local/bin/, and a mise install does the same under its
  // installs/red-dev/latest/ tree). `process.execPath` is the red-dev
  // binary itself; the scriptc build is `redwall` next to it.
  const sibling = process.execPath && isAbsolute(process.execPath)
    ? join(dirname(process.execPath), "redwall")
    : "";

  const candidates = [
    process.env[ENV_OVERRIDE],
    sibling,
    VENDOR_RELATIVE,
    `${process.env["HOME"] ?? ""}/.local/share/mise/installs/redwall/latest/redwall`,
  ];
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== "" && existsSync(candidate)) return candidate;
  }
  return null;
}

export interface ScriptcRenderInput {
  readonly state: Record<string, unknown>;
  readonly themeSlug: string;
}

/**
 * Render via the scriptc binary, if one is reachable. Otherwise null.
 *
 * Never throws. A binary that exists but fails to render returns null so
 * the caller can try the in-process renderer. Returns the PNG bytes on
 * success.
 */
export async function renderRedwallViaBin(
  input: ScriptcRenderInput,
  options: {
    run?: (argv: string[], opts?: BoundedCommandOptions) => Promise<{ exitCode: number | null; stdout: Uint8Array; stderr: string }>;
  } = {},
): Promise<Uint8Array | null> {
  const bin = resolveVendorBin();
  if (bin === null) return null;
  if (!(input.themeSlug in THEMES)) return null;

  const run = options.run ?? runBoundedCapture;
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(input.state)) {
    if (value === null || value === undefined) continue;
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      env[`REDWALL_${key.toUpperCase()}`] = String(value);
    } else if (typeof value === "string" && value !== "") {
      env[`REDWALL_${key.toUpperCase()}`] = value;
    }
  }
  env["REDWALL_THEME"] = input.themeSlug;
  env["REDWALL_OUT"] = ""; // forces stdout

  const result = await run([bin], { env, timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    process.stderr.write(`redwall-bin: exit ${result.exitCode}: ${result.stderr}\n`);
    return null;
  }
  return result.stdout;
}

async function runBoundedCapture(
  argv: string[],
  options: BoundedCommandOptions = {},
): Promise<{ exitCode: number | null; stdout: Uint8Array; stderr: string }> {
  // The bounded runner's `stdout` is a string; we need raw bytes for the PNG.
  const result = await runBounded(argv, options);
  return {
    exitCode: result.exitCode,
    stdout: new TextEncoder().encode(result.stdout),
    stderr: result.stderr,
  };
}