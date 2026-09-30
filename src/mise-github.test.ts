import { afterEach, describe, expect, test } from "bun:test";
import type { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convergeMiseGithubAuth, migrateMiseGithubCredential, miseGithubCredentialCommand, miseRemoteVersionsEnv } from "./mise-github.ts";
import { convergeMiseConfig, miseConfigPath } from "./mise-config.ts";
import type { Platform } from "./platform.ts";

interface AuthConfig { settings: { github: { credential_command: string } } }

const temporary: string[] = [];
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }); });
function temp(): string {
  const path = mkdtempSync(join(tmpdir(), "red-dev github auth "));
  temporary.push(path);
  return path;
}

describe("mise credentials without re-entering its shim", () => {
  test("a native gh needs no mise subprocess and selects github.com explicitly", () => {
    const command = miseGithubCredentialCommand(
      () => "/usr/bin/gh",
      (() => { throw new Error("must not spawn"); }) as typeof spawnSync,
    );
    expect(command).toBe('"/usr/bin/gh" auth token --hostname github.com');
  });

  test("a shim is resolved with local which, never auth token through mise", () => {
    const calls: unknown[] = [];
    const executable = "/data/mise/installs/github-cli/latest/bin/gh";
    const run = ((cmd: string, args: string[], opts: unknown) => {
      calls.push({ cmd, args, opts });
      return { status: 0, stdout: `${executable}\n` };
    }) as typeof spawnSync;
    expect(miseGithubCredentialCommand(
      (cmd) => cmd === "gh" ? "/data/mise/shims/gh" : "/usr/bin/mise",
      run,
      (path) => path === executable,
    )).toBe(`"${executable}" auth token --hostname github.com`);
    expect(calls).toEqual([{
      cmd: "/usr/bin/mise", args: ["which", "gh"],
      opts: expect.objectContaining({ timeout: 2_000, env: expect.objectContaining({ MISE_AUTO_INSTALL: "0" }) }),
    }]);
  });

  test("failed or recursive resolution disables the command rather than invoking the shim", () => {
    for (const stdout of ["", "/data/mise/shims/gh\n", "/missing/gh\n", "relative/gh\n"]) {
      const run = (() => ({ status: 0, stdout })) as unknown as typeof spawnSync;
      expect(miseGithubCredentialCommand(
        (cmd) => cmd === "gh" ? "/data/mise/shims/gh" : "/usr/bin/mise",
        run,
        () => false,
      )).toBe("");
    }
  });

  test("Windows paths with spaces remain one command argument", () => {
    expect(miseGithubCredentialCommand(() => "C:\\Program Files\\GitHub CLI\\gh.exe"))
      .toBe('"C:/Program Files/GitHub CLI/gh.exe" auth token --hostname github.com');
  });

  test("a fresh machine uses the gh installed later by its native provider", () => {
    expect(miseGithubCredentialCommand(() => null))
      .toBe("gh auth token --hostname github.com");
  });
});

describe("remote version request cadence", () => {
  test("ordinary installs and probes reuse metadata; explicit updates refresh it", () => {
    expect(miseRemoteVersionsEnv()).toEqual({ MISE_FETCH_REMOTE_VERSIONS_CACHE: "1h" });
    expect(miseRemoteVersionsEnv(true)).toEqual({ MISE_FETCH_REMOTE_VERSIONS_CACHE: "0s" });
  });
});

describe("persistent authentication owned by red-dev", () => {
  test("repairs an old gh override and keeps unrelated tools, comments and CRLF", () => {
    const source = '# my tools\r\n[tools]\r\nnode = "24"\r\n[settings.github]\r\ncredential_command = "gh auth token"\r\n# retain me\r\napi_url = "https://api.github.com"\r\n';
    const command = 'sh "/config/red-dev-github-auth.sh"';
    const next = migrateMiseGithubCredential(source, command);
    expect((Bun.TOML.parse(next) as AuthConfig).settings.github.credential_command).toBe(command);
    expect(next).toContain('# my tools\r\n[tools]\r\nnode = "24"\r\n');
    expect(next).toContain('# retain me\r\napi_url = "https://api.github.com"');
    expect(migrateMiseGithubCredential(next, command)).toBe(next);
  });

  test("backs up obsolete settings once and does not rewrite on the next converge", () => {
    const root = temp();
    const config = join(root, "config.toml");
    const source = '[settings]\ngithub.credential_command = "gh auth token"\n';
    writeFileSync(config, source);
    const first = convergeMiseGithubAuth(root, "linux");
    expect(first.changed).toBe(true);
    expect(readFileSync(`${config}.red-dev-github-auth.bak`, "utf8")).toBe(source);
    expect((Bun.TOML.parse(readFileSync(config, "utf8")) as AuthConfig).settings.github.credential_command).toBe(first.command);
    expect(convergeMiseGithubAuth(root, "linux").changed).toBe(false);
  });

  test("an unrelated custom credential provider is preserved", () => {
    const source = '[settings.github]\ncredential_command = "company-secrets github"\n';
    expect(migrateMiseGithubCredential(source, "managed-command")).toBe(source);
  });

  test("Windows generates a persistent PowerShell command with a quoted path", () => {
    const root = temp();
    const result = convergeMiseGithubAuth(root, "win32");
    expect(result.command).toContain("powershell.exe -NoProfile -NonInteractive");
    expect(result.command).toContain(JSON.stringify(join(root, "red-dev-github-auth.ps1")));
    const script = readFileSync(join(root, "red-dev-github-auth.ps1"), "utf8");
    expect(script).toContain("mise which gh");
    expect(script).toContain("auth token --hostname github.com");
  });

  test.skipIf(process.platform === "win32")("direct mise reads the active gh account even after gh moves to a new version", () => {
    const realMise = Bun.which("mise");
    const home = temp();
    const root = join(home, ".config", "mise");
    const bin = join(home, "fixture bin");
    mkdirSync(bin, { recursive: true });
    const activeGh = join(bin, "active-gh");
    const account = join(bin, "account");
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const fixtureMise = join(bin, "mise");
    writeFileSync(fixtureMise, `#!/bin/sh\n[ "$1 $2" = "which gh" ] || exit 2\ncat ${quote(activeGh)}\n`);
    chmodSync(fixtureMise, 0o700);
    for (const version of ["v1", "v2"]) {
      const executable = join(bin, version, "gh");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, `#!/bin/sh\n[ "$*" = "auth token --hostname github.com" ] || exit 3\ncat ${quote(account)}\n`);
      chmodSync(executable, 0o700);
    }
    const platform: Platform = { os: "linux", distro: "ubuntu", version: "26.04", codename: "resolute", env: "desktop", arch: "x64", caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true } };
    convergeMiseConfig(platform, { home, tools: [] });
    const config = Bun.TOML.parse(readFileSync(miseConfigPath(home), "utf8")) as AuthConfig;
    expect(config.settings.github.credential_command).toContain("red-dev-github-auth.sh");
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env.PATH}`, MISE_CONFIG_DIR: root };
    for (const name of ["MISE_CONFIG_FILE", "MISE_GITHUB_CREDENTIAL_COMMAND", "MISE_GITHUB_TOKEN", "GITHUB_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN"]) delete env[name];
    const lookup = () => {
      const argv = realMise ? [realMise, "token", "github", "--raw"] : ["sh", join(root, "red-dev-github-auth.sh")];
      const result = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    writeFileSync(activeGh, join(bin, "v1", "gh"));
    writeFileSync(account, "fixture_account_one\n");
    expect(lookup()).toBe("fixture_account_one");
    writeFileSync(activeGh, join(bin, "v2", "gh"));
    rmSync(join(bin, "v1"), { recursive: true });
    writeFileSync(account, "fixture_account_two\n");
    expect(lookup()).toBe("fixture_account_two");
    expect(convergeMiseConfig(platform, { home, tools: [] }).changed).toBe(false);
  });
});
