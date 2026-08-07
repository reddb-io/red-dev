/**
 * A scratch directory, and getting rid of it, on all five targets.
 *
 * Both halves of this had a native-Windows bug, and both reported it as
 * somebody else's failure.
 *
 * `/tmp/red-dev-font-X` is two different directories depending on who
 * resolves it. A native Windows process writes that to C:\tmp; Git Bash
 * resolves /tmp to %LOCALAPPDATA%\Temp. So a file written by red-dev and
 * read by a shell it spawned were not the same file:
 *
 *   /bin/bash: /tmp/red-dev-installer-1786098097590.sh: No such file
 *
 * And cleanup shelled out to `rm`, which native Windows does not have,
 * so every step that got that far ended with
 *
 *   Executable not found in $PATH: "rm"
 *
 * — attributed to nerd-font and red-skills, which had done nothing
 * wrong. Both were reported as failures of the thing being installed
 * rather than of the plumbing, which is what made them survive several
 * releases.
 *
 * os.tmpdir() answers correctly on every target, and node:fs removes a
 * tree without a process. Forward slashes throughout: Bun writes them
 * fine on Windows and Git Bash accepts `C:/Users/.../Temp/x`, so one
 * spelling serves both sides.
 */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

/** A fresh scratch directory, created, in a place every target agrees on. */
export function tempDir(name: string): string {
  const path = `${tmpdir().replace(/\\/g, "/")}/red-dev-${name}`;
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
  return path;
}

/** A scratch file path. Not created — the caller writes it. */
export function tempFile(name: string): string {
  return `${tmpdir().replace(/\\/g, "/")}/red-dev-${name}`;
}

/**
 * Remove a file or tree, on any target, without spawning anything.
 *
 * Never throws. Cleanup that fails must not turn a successful install
 * into a reported failure — which is exactly what shelling out to `rm`
 * did.
 */
export function removeTemp(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // A scratch file left behind is not worth failing a converge over.
  }
}
