/**
 * A Windows binary answering a POSIX shell.
 *
 * `mise activate bash` on Git Bash runs a Windows mise.exe, which cannot
 * tell that the bash asking is an MSYS one. It prints `export PATH=`
 * with semicolons and backslashes; bash splits PATH on ':', so
 * `C:\Users\...` becomes the entry `C` followed by `\Users\...`, the
 * whole list collapses, and every tool on it stops resolving.
 *
 * Measured on the machine that reported it: before the line,
 * `command -v grep` is /usr/bin/grep. After it, empty. So are sed, head,
 * cygpath — and zellij, which is why the always-on session never started
 * on the Windows side and looked like a zellij problem for a day.
 *
 * The rest of init.sh is a list of `command -v` guards, so this does not
 * merely lose grep: it silently switches off zoxide, fzf, atuin,
 * carapace and direnv, none of which report anything.
 *
 * Tested with stubs rather than on Windows: what makes this bug is the
 * shape of what mise prints, and a stub can print that shape anywhere.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const INIT = `${import.meta.dir}/../config/bash/init.sh`;

/** A Windows-shaped PATH, exactly as mise.exe hands one back. */
const WINDOWS_PATH = String.raw`C:\Users\filip\AppData\Local\mise\shims;C:\Program Files\Git\usr\bin;C:\Windows\system32`;

/**
 * A fake Git Bash: a mise that answers like the Windows one, and a
 * cygpath that converts a path list back the way the real one does.
 */
function stubs(): string {
  const dir = mkdtempSync(`${tmpdir()}/red-gitbash-`);

  // Through a quoted heredoc, which emits its body byte for byte. The
  // first attempt built these with printf and escapes, and lost the
  // backslashes to two layers of quoting before bash ever saw them —
  // the stub has to reproduce the bug exactly or it tests nothing.
  writeFileSync(
    `${dir}/mise`,
    [
      "#!/bin/sh",
      `[ "$1" = "activate" ] && cat <<'EOS'`,
      // Quoted the way mise quotes it. Unquoted, those semicolons are
      // command separators and the shell never sees the bug at all.
      //
      // Prepending rather than replacing, because the real one keeps
      // the entries it was given. Replacing outright also deleted the
      // directory these stubs live in, so the activations further down
      // init.sh were never reached and the test below tested nothing.
      String.raw`export PATH="${WINDOWS_PATH};$PATH"`,
      "EOS",
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(`${dir}/mise`, 0o755);

  // The second mangler, and the reason one repair was not enough: it
  // runs after mise has already been fixed and prepends its own bin
  // directory in Windows spelling, gluing two directories into one that
  // is neither.
  writeFileSync(
    `${dir}/carapace`,
    [
      "#!/bin/sh",
      `cat <<'EOS'`,
      String.raw`export PATH="C:\Users\filip\AppData\Roaming\carapace\bin;$PATH"`,
      "EOS",
      "",
    ].join("\n"),
  );
  chmodSync(`${dir}/carapace`, 0o755);

  // -p is cygpath's path-list mode: semicolons become colons and
  // backslashes become forward slashes. tr rather than sed, so there is
  // one less escaping layer to get wrong.
  writeFileSync(
    `${dir}/cygpath`,
    [
      "#!/bin/sh",
      // Its own PATH, because it inherits the mangled one and would
      // otherwise fail to find tr — the real cygpath is a binary and
      // needs no PATH at all.
      "PATH=/usr/bin:/bin",
      String.raw`printf '%s\n' "$2" | tr ';' ':' | tr '\\' '/'`,
      "",
    ].join("\n"),
  );
  chmodSync(`${dir}/cygpath`, 0o755);

  return dir;
}

/** Source init.sh in a shell that looks like the target, report PATH. */
function pathAfterInit(
  env: Record<string, string>,
  cygpath: "works" | "fails" = "works",
): string {
  const dir = stubs();
  if (cygpath === "fails") {
    // Found on PATH and unable to answer. This is the case that caught
    // the first version of the fix assigning an empty PATH.
    writeFileSync(`${dir}/cygpath`, "#!/bin/sh\nexit 127\n");
    chmodSync(`${dir}/cygpath`, 0o755);
  }

  const proc = Bun.spawnSync(["bash", "--norc", "-c", `. ${INIT}; printf '%s' "$PATH"`], {
    env: { PATH: `${dir}:/usr/bin:/bin`, HOME: dir, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  return new TextDecoder().decode(proc.stdout);
}

describe("mise on Git Bash", () => {
  test("leaves a PATH bash can actually split", () => {
    const path = pathAfterInit({ RED_ENV: "windows" });
    // The bug in one assertion: a semicolon anywhere in PATH means bash
    // is looking at one enormous directory name.
    expect(path).not.toContain(";");
  });

  test("keeps the directories, rather than dropping them to be safe", () => {
    const path = pathAfterInit({ RED_ENV: "windows" });
    expect(path).toContain("mise");
    expect(path).toContain("Git/usr/bin");
  });

  test("does not reach for cygpath where PATH was never mangled", () => {
    // WSL and Linux run a Linux mise, which prints a POSIX PATH. Running
    // the conversion there would be a no-op at best and damage at worst,
    // so the mangled shape is expected to survive untouched here.
    expect(pathAfterInit({ RED_ENV: "wsl" })).toContain(";");
  });

  test("repairs what a later activation mangles, not only mise", () => {
    // One repair, placed after mise, left the machine with an entry
    // reading `.../carapace/bin;/c/.../mise/installs/bun/.../bin` —
    // two directories glued into one, so bun stopped resolving. The
    // fix runs again at the end for exactly this.
    const path = pathAfterInit({ RED_ENV: "windows" });
    expect(path).toContain("carapace");
    expect(path).not.toContain(";");
  });

  test("never hands back an empty PATH when cygpath cannot answer", () => {
    // The first version of the fix did exactly that, and an empty PATH
    // is a worse shell than the mangled one being repaired.
    const path = pathAfterInit({ RED_ENV: "windows" }, "fails");
    expect(path.length).toBeGreaterThan(0);
    expect(path).toContain("mise");
  });
});
