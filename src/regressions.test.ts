/**
 * Tests for the bugs that actually shipped.
 *
 * Each of these was found by a user running the tool, not by a test —
 * and each was invisible in every green build beforehand. They are
 * grouped here rather than scattered because what they have in common
 * is the useful part: all three failed silently, producing plausible
 * output that happened to be wrong.
 */

import { describe, expect, test } from "bun:test";
import { wingetArgv } from "./providers.ts";
import { linuxFontProbeArgv, machineWideFontScript, windowsFontProbeArgv } from "./wsl.ts";

describe("winget invocation", () => {
  /**
   * winget is an APPEXECLINK reparse point. A process cannot exec one,
   * not by name and not by the absolute path where.exe returns, so
   * every winget install on native Windows failed with "Executable not
   * found in $PATH" while `caps: winget=1` insisted it was there.
   * cmd.exe resolves execution aliases; nothing else here does.
   */
  test("goes through cmd.exe on native Windows", () => {
    const argv = wingetArgv(["install", "--id", "Foo.Bar"], "win32");
    expect(argv.slice(0, 3)).toEqual(["cmd.exe", "/c", "winget"]);
    expect(argv).toContain("Foo.Bar");
  });

  test("calls winget.exe directly from WSL, where interop makes it a normal binary", () => {
    const argv = wingetArgv(["install", "--id", "Foo.Bar"], "linux");
    expect(argv[0]).toMatch(/winget\.exe$/);
    expect(argv[1]).toBe("install");
  });

  test("passes arguments through unchanged on both", () => {
    const args = ["upgrade", "--all", "--silent"];
    expect(wingetArgv(args, "win32").slice(3)).toEqual(args);
    expect(wingetArgv(args, "linux").slice(1)).toEqual(args);
  });
});

/**
 * The `next` channel served the stable release to everyone who asked
 * for it, because /releases is not ordered newest-prerelease-first and
 * boot.sh took element zero.
 *
 * Testing the awk directly rather than the whole bootstrap: the shell
 * around it is a download and a chmod, and the part that was wrong is
 * the extraction.
 */
describe("boot.sh next-channel selection", () => {
  // Field order matches GitHub's: tag_name, then prerelease, then
  // assets. Getting that order wrong is what made the first attempt
  // read the previous release's flag.
  const FIXTURE = JSON.stringify([
    {
      tag_name: "v1.0.0",
      prerelease: false,
      assets: [
        { name: "red-dev-linux-x64", browser_download_url: "https://x/v1.0.0/red-dev-linux-x64" },
      ],
    },
    {
      tag_name: "v1.0.1-next.9",
      prerelease: true,
      assets: [
        { name: "checksums.txt", browser_download_url: "https://x/v1.0.1-next.9/checksums.txt" },
        {
          name: "red-dev-linux-x64",
          browser_download_url: "https://x/v1.0.1-next.9/red-dev-linux-x64",
        },
      ],
    },
    {
      tag_name: "v1.0.1-next.8",
      prerelease: true,
      assets: [
        {
          name: "red-dev-linux-x64",
          browser_download_url: "https://x/v1.0.1-next.8/red-dev-linux-x64",
        },
      ],
    },
  ]);

  const AWK = `
    /"prerelease"[[:space:]]*:[[:space:]]*true/  { pre = 1; next }
    /"prerelease"[[:space:]]*:[[:space:]]*false/ { pre = 0; next }
    pre && /"browser_download_url"/ {
      n = split($0, q, "\\"")
      if (n >= 4 && q[4] ~ ("/" asset "$")) { print q[4]; exit }
    }
  `;

  function pick(json: string, asset: string): string {
    const proc = Bun.spawnSync([
      "sh",
      "-c",
      `printf '%s' "$1" | tr '{},' '\\n' | awk -v asset="$2" '${AWK}'`,
      "sh",
      json,
      asset,
    ]);
    return new TextDecoder().decode(proc.stdout).trim();
  }

  test("picks the newest prerelease, not the first release listed", () => {
    // The stable is first in the array; taking [0] is what shipped a
    // binary three fixes behind to everyone who asked for next.
    expect(pick(FIXTURE, "red-dev-linux-x64")).toBe(
      "https://x/v1.0.1-next.9/red-dev-linux-x64",
    );
  });

  test("does not settle for another asset in the right release", () => {
    // checksums.txt precedes the binary inside the same release, so a
    // matcher that ignores the asset name returns the wrong file.
    expect(pick(FIXTURE, "red-dev-linux-x64")).not.toContain("checksums");
  });

  test("returns nothing when no prerelease carries the asset", () => {
    const onlyStable = JSON.stringify([
      {
        tag_name: "v1.0.0",
        prerelease: false,
        assets: [{ name: "red-dev-linux-x64", browser_download_url: "https://x/a" }],
      },
    ]);
    // Empty is correct here: the caller reports which assets exist,
    // which beats downloading the stable while claiming it is next.
    expect(pick(onlyStable, "red-dev-linux-x64")).toBe("");
  });

  test("extraction survives POSIX awk, which has no backreferences", () => {
    // sub(/.../, "\\1") silently yields the literal string, so every
    // URL became "\1" and nothing matched, with no error anywhere.
    const url = pick(FIXTURE, "red-dev-linux-x64");
    expect(url).toStartWith("https://");
    expect(url).not.toContain("\\1");
  });
});

/**
 * A per-user font install can be correct and still invisible.
 *
 * The files landed in %LOCALAPPDATA%\Microsoft\Windows\Fonts, the HKCU
 * entries carried the right family names, and doctor could have checked
 * both and said yes. Windows 11 on an Entra-joined machine ignored the
 * lot — across a sign-out — and Alacritty refused to start: font
 * "FiraCode Nerd Font Mono" not found. The repair is to install for the
 * whole machine, which needs elevation, which is why the check that
 * triggers it has to ask the font stack rather than the filesystem.
 */
describe("machine-wide font install script", () => {
  const script = machineWideFontScript("FiraCode", "C:\\Users\\x\\AppData\\Local\\Temp\\r.log");

  test("registers under HKLM, where a machine-wide font belongs", () => {
    expect(script).toContain("HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts");
    expect(script).toContain("$env:SystemRoot\\Fonts");
  });

  test("names the file, not the path", () => {
    // HKLM entries are resolved against the system font directory; a
    // full path there is the per-user spelling and does not resolve.
    expect(script).toContain("-Value $f.Name");
  });

  test("takes only the Mono faces already staged per-user", () => {
    expect(script).toContain('-Filter "FiraCodeNerdFontMono-*.ttf"');
  });

  test("survives the template literal it is written in", () => {
    // The script is a TS template string full of $ and \. One escaped
    // dollar turns a variable into text and the install silently does
    // nothing, so assert the PowerShell that comes out is PowerShell.
    expect(script).toContain("$f.BaseName -match '-(\\w+)$'");
    expect(script).not.toContain("\\\\");
    expect(script).not.toContain("\\$");
  });

  test("reports its outcome to the file the caller reads", () => {
    // An elevated child is a separate process tree: its stdout never
    // comes home, so success that is not written down reads as failure.
    expect(script).toContain("$result = 'C:\\Users\\x\\AppData\\Local\\Temp\\r.log'");
    expect(script).toContain('"installed $count" | Set-Content $result');
    expect(script).toContain("| Set-Content $result\n}");
  });

  test("parses as PowerShell", () => {
    // Skipped where there is no PowerShell to ask; the assertion is
    // worth having on the platform this code actually runs on.
    const shell =
      Bun.which("powershell.exe") ??
      "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    if (!Bun.which(shell)) return;

    const probe = `
$errors = $null
[System.Management.Automation.Language.Parser]::ParseInput(
  [IO.File]::ReadAllText($args[0]), [ref]$null, [ref]$errors) | Out-Null
if ($errors.Count) { $errors | ForEach-Object { $_.Message }; exit 1 }
"parsed"
`;
    const path = "/tmp/red-dev-font-script-test.ps1";
    const probePath = "/tmp/red-dev-font-parse-test.ps1";
    Bun.write(path, script);
    Bun.write(probePath, probe);
    const win = (p: string) =>
      new TextDecoder().decode(Bun.spawnSync(["wslpath", "-w", p]).stdout).trim();

    const proc = Bun.spawnSync([
      shell,
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      win(probePath),
      win(path),
    ]);
    expect(new TextDecoder().decode(proc.stdout).trim()).toBe("parsed");
  });
});

describe("font installation verification", () => {
  test("Linux verifies through fontconfig, not terminal config", () => {
    expect(linuxFontProbeArgv("FiraCode Nerd Font Mono")).toEqual([
      "fc-match",
      "--format",
      "%{family}\n",
      "FiraCode Nerd Font Mono",
    ]);
  });

  test("Windows verifies through the installed font collection", () => {
    const argv = windowsFontProbeArgv("FiraCode Nerd Font Mono");
    expect(argv).toContain("-Command");
    expect(argv.join(" ")).toContain("InstalledFontCollection");
    expect(argv.join(" ")).toContain("FiraCode Nerd Font Mono");
    expect(argv.join(" ")).not.toContain("settings.json");
  });
});
