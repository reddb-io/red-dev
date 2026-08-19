/**
 * Did the install actually produce a working tool?
 *
 * Every provider here reports success when the command it ran exited
 * zero, which is a claim about the installer and not about the machine.
 * The gap between them is where this project's worst bugs have lived:
 * a winget id that installed the wrong package, a `gh` asset that
 * unpacked to a name nothing puts on PATH, an apt package that reported
 * `install ok installed` while the binary answering on PATH was GNU ed.
 *
 * So after an install, the tool is looked for, run, and asked what it
 * is. The answer is narrated whatever it is.
 *
 * It is narrated rather than enforced, deliberately. A binary that has
 * just landed in ~/.local/bin is not necessarily on *this* process's
 * PATH — that directory is added by the shell configuration a converge
 * also writes, and takes effect in the next shell. Failing an install
 * over that would turn every fresh machine red for something that is
 * working. The install directories are searched directly for the same
 * reason.
 */

import { existsSync } from "node:fs";

import { parseVersion, compareVersions, type Tool } from "./manifest.ts";
import { miseDataRoot } from "./mise-config.ts";
import { userBinDir, windowsBinDir } from "./providers.ts";

/** Where an install can have put a binary that PATH does not know yet. */
function installDirs(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(userBinDir());
  } catch {
    // No HOME is not a reason to fail a verification.
  }
  // mise's shims, for the run that just installed one.
  //
  // config/bash/path.sh puts this directory on PATH, so by the next
  // shell Bun.which finds these on its own. The run doing the
  // installing is the exception: its PATH was inherited from a shell
  // that started before the shim existed, so a converge would install a
  // tool successfully and then report it missing on the very next line.
  //
  // Through miseDataRoot rather than spelled again here: mise's data
  // directory is `%LOCALAPPDATA%\mise` on Windows and an XDG path
  // everywhere else, and the copy of that rule this file used to carry
  // knew only the unix half. The visible cost was a Windows converge
  // that installed a tool and then said it was not on PATH yet — true
  // of the directory it was looking in, which was one mise had never
  // written to.
  dirs.push(`${miseDataRoot().replace(/\\/g, "/")}/shims`);
  if (process.platform === "win32") {
    try {
      dirs.push(windowsBinDir().replace(/\\/g, "/"));
    } catch {
      // windowsBinDir throws without LOCALAPPDATA; nothing to search.
    }
  }
  return dirs;
}

/** %VAR% expanded, the way manifest.ts expands declared file paths. */
function expand(path: string): string {
  return path.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, name: string) => process.env[name] ?? m);
}

/**
 * Where this tool is, after installing it, or null.
 *
 * PATH first, since that is what a user will actually get, then the
 * directories an install writes to — a tool found only in the second is
 * installed correctly and simply not visible until the next shell.
 */
export function locateTool(tool: Tool): string | null {
  if (tool.file) {
    const path = expand(tool.file);
    return existsSync(path) ? path : null;
  }
  const dirs = installDirs();
  for (const candidate of tool.cmd ?? [tool.name]) {
    const onPath = Bun.which(candidate);
    if (onPath) return onPath;
    for (const dir of dirs) {
      for (const name of [candidate, `${candidate}.exe`]) {
        const path = `${dir}/${name}`;
        if (existsSync(path)) return path;
      }
    }
  }
  return null;
}

/**
 * `<bin> --version`, both streams, or null when it will not run.
 *
 * stdin detached for the reason manifest.ts documents on its own probe:
 * the thing being run is by definition one whose identity is not yet
 * established, and an editor handed a terminal it can read never
 * returns.
 */
export function runVersion(path: string): string | null {
  try {
    const proc = Bun.spawnSync([path, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
    });
    const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`;
    return out.trim().length > 0 ? out : null;
  } catch {
    return null;
  }
}

export interface VerificationInput {
  tool: string;
  /** Resolved location, or null when nothing was found. */
  path: string | null;
  /** Whatever `--version` printed, unparsed. */
  output: string | null;
  pinVersion?: string;
  minVersion?: string;
  /** A file, a font, a settings tree — nothing to execute. */
  managed?: boolean;
}

export interface Verification {
  lines: { level: "info" | "ok" | "warn"; message: string }[];
  /** Whether the version found satisfies the pin or the floor. */
  satisfied: boolean;
  version: string | null;
}

/**
 * What to say about an install that has just happened. PURE.
 *
 * Pure because this is the part worth asserting: the probing is two
 * system calls, the wording is the thing an operator reads, and a
 * verification that says "satisfies" about a version that does not is
 * worse than no verification at all.
 */
export function verificationLines(input: VerificationInput): Verification {
  const lines: Verification["lines"] = [];

  if (input.managed) {
    // A managed item has no binary and no version. Saying "not on PATH"
    // about a font or a settings file is a false alarm on every run.
    return { lines, satisfied: true, version: null };
  }

  if (!input.path) {
    lines.push({
      level: "warn",
      message: `${input.tool} is not on PATH yet — the installer reported success; open a new shell and check`,
    });
    return { lines, satisfied: false, version: null };
  }

  lines.push({ level: "info", message: `found at ${input.path}` });

  if (input.output === null) {
    lines.push({ level: "warn", message: `${input.tool} --version did not run` });
    return { lines, satisfied: false, version: null };
  }

  const reported = input.output.trim().split("\n")[0]?.trim() ?? "";
  const version = parseVersion(input.output);
  lines.push({ level: "info", message: `--version says: ${reported}` });

  if (input.pinVersion) {
    if (version === null) {
      lines.push({
        level: "warn",
        message: `cannot read a version out of that output; pinned to ${input.pinVersion}`,
      });
      return { lines, satisfied: false, version };
    }
    const ok = compareVersions(version, input.pinVersion) === 0;
    lines.push(
      ok
        ? { level: "ok", message: `${version} is the pinned version` }
        : { level: "warn", message: `${version} is not the pinned ${input.pinVersion}` },
    );
    return { lines, satisfied: ok, version };
  }

  if (input.minVersion) {
    if (version === null) {
      lines.push({
        level: "warn",
        message: `cannot read a version out of that output; needs at least ${input.minVersion}`,
      });
      return { lines, satisfied: false, version };
    }
    const ok = compareVersions(version, input.minVersion) >= 0;
    lines.push(
      ok
        ? { level: "ok", message: `${version} satisfies the ${input.minVersion} floor` }
        : { level: "warn", message: `${version} is below the required ${input.minVersion}` },
    );
    return { lines, satisfied: ok, version };
  }

  // No expectation declared: running is the expectation, and it ran.
  return { lines, satisfied: true, version };
}

/** Probe the machine, then say what it found. */
export function verifyInstalled(tool: Tool): Verification {
  const path = locateTool(tool);
  // A declared file is proof by existence — there is nothing to execute,
  // and spawning a settings file would be a genuinely strange thing to do.
  const output = path && !tool.file ? runVersion(path) : null;
  if (tool.file) {
    return {
      lines: path
        ? [{ level: "info", message: `found at ${path}` }]
        : [{ level: "warn", message: `${tool.name}: ${tool.file} is still missing` }],
      satisfied: path !== null,
      version: null,
    };
  }
  return verificationLines({
    tool: tool.name,
    path,
    output,
    ...(tool.pinVersion ? { pinVersion: tool.pinVersion } : {}),
    ...(tool.minVersion ? { minVersion: tool.minVersion } : {}),
    ...(tool.managed ? { managed: tool.managed } : {}),
  });
}
