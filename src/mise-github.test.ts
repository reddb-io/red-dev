import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { convergeMiseGithubAuth, migrateMiseGithubCredential, miseGithubCredentialCommand, miseRemoteVersionsEnv, MISE_GITHUB_AUTH_SH } from "./mise-github.ts";
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
  test("a native gh is used directly and selects github.com explicitly", () => {
    expect(miseGithubCredentialCommand({ locate: () => "/usr/bin/gh" }))
      .toBe('"/usr/bin/gh" auth token --hostname github.com');
  });

  test("a shim is bypassed using the filesystem, including archive directories", () => {
    const executable = "/data/mise/installs/github-cli/latest/gh_2_linux_amd64/bin/gh";
    expect(miseGithubCredentialCommand({
      locate: () => "/data/mise/shims/gh",
      env: { PATH: "/data/mise/shims", MISE_DATA_DIR: "/data/mise" },
      has: path => path === executable,
      list: path => path.endsWith("/latest") ? ["gh_2_linux_amd64"] : [],
    })).toBe(`"${executable}" auth token --hostname github.com`);
  });

  test("a native gh later on PATH is preferred over the shim", () => {
    expect(miseGithubCredentialCommand({
      locate: () => "/data/mise/shims/gh",
      env: { PATH: "/data/mise/shims:/usr/bin" },
      has: path => path === "/usr/bin/gh", list: () => [],
    })).toBe('"/usr/bin/gh" auth token --hostname github.com');
  });

  test("a missing real executable disables the command, without invoking a shim", () => {
    expect(miseGithubCredentialCommand({
      locate: () => "/data/mise/shims/gh", env: { PATH: "", MISE_DATA_DIR: "/missing" },
      has: () => false, list: () => [],
    })).toBe("");
  });

  test("Windows paths with spaces remain one command argument", () => {
    expect(miseGithubCredentialCommand({ locate: () => "C:/Program Files/GitHub CLI/gh.exe" }))
      .toBe('"C:/Program Files/GitHub CLI/gh.exe" auth token --hostname github.com');
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
    expect(script).not.toContain("mise which gh");
    expect(script).toContain("auth token --hostname github.com");
  });

  test.skipIf(process.platform === "win32")("direct mise reads the active gh account even after gh moves to a new version", () => {
    const realMise = Bun.which("mise");
    const home = temp();
    const root = join(home, ".config", "mise");
    const bin = join(home, "fixture bin");
    mkdirSync(bin, { recursive: true });
    const data = join(home, "mise data");
    const installs = join(data, "installs", "github-cli");
    const shims = join(data, "shims");
    mkdirSync(shims, { recursive: true });
    const account = join(bin, "account");
    const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
    const fixtureMise = join(bin, "mise");
    writeFileSync(fixtureMise, `#!/bin/sh\nprintf invoked > ${quote(join(bin, "mise-invoked"))}\nsleep 30\n`);
    chmodSync(fixtureMise, 0o700);
    for (const version of ["v1", "v2"]) {
      const executable = join(installs, version, "gh_fixture_linux_amd64", "bin", "gh");
      mkdirSync(dirname(executable), { recursive: true });
      writeFileSync(executable, `#!/bin/sh\n[ "$*" = "auth token --hostname github.com" ] || exit 3\ncat ${quote(account)}\n`);
      chmodSync(executable, 0o700);
    }
    const platform: Platform = { os: "linux", distro: "ubuntu", version: "26.04", codename: "resolute", env: "desktop", arch: "x64", caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true } };
    convergeMiseConfig(platform, { home, tools: [] });
    const config = Bun.TOML.parse(readFileSync(miseConfigPath(home), "utf8")) as AuthConfig;
    expect(config.settings.github.credential_command).toContain("red-dev-github-auth.sh");
    symlinkSync(Bun.which("sh")!, join(bin, "sh"));
    symlinkSync(Bun.which("cat")!, join(bin, "cat"));
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shims}:${bin}`, MISE_CONFIG_DIR: root, MISE_DATA_DIR: data };
    for (const name of ["MISE_CONFIG_FILE", "MISE_GITHUB_CREDENTIAL_COMMAND", "MISE_GITHUB_TOKEN", "GITHUB_TOKEN", "GITHUB_API_TOKEN", "GH_TOKEN", "WSL_INTEROP", "WSL_DISTRO_NAME"]) delete env[name];
    const lookup = () => {
      const argv = realMise ? [realMise, "token", "github", "--raw"] : ["sh", join(root, "red-dev-github-auth.sh")];
      const result = Bun.spawnSync(argv, { env, stdout: "pipe", stderr: "pipe", timeout: 5_000 });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    };
    writeFileSync(join(shims, "gh"), "#!/bin/sh\nexit 77\n");
    chmodSync(join(shims, "gh"), 0o700);
    symlinkSync(join(installs, "v1"), join(installs, "latest"));
    writeFileSync(account, "fixture_account_one\n");
    expect(lookup()).toBe("fixture_account_one");
    rmSync(join(installs, "latest"));
    symlinkSync(join(installs, "v2"), join(installs, "latest"));
    rmSync(join(installs, "v1"), { recursive: true });
    writeFileSync(account, "fixture_account_two\n");
    expect(lookup()).toBe("fixture_account_two");
    expect(existsSync(join(bin, "mise-invoked"))).toBe(false);
    expect(convergeMiseConfig(platform, { home, tools: [] }).changed).toBe(false);
  });
});


describe("WSL credential fallback", () => {
  test.skipIf(process.platform === "win32")("uses Windows gh only when the local account is unavailable; never invokes mise", () => {
    const root = temp(), bin = join(root, "bin"); mkdirSync(bin);
    const account = join(root, "host-account"), observed = join(root, "host-script");
    const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
    const gh = join(bin, "gh"), ps = join(bin, "powershell.exe"), script = join(root, "auth.sh");
    writeFileSync(script, MISE_GITHUB_AUTH_SH);
    writeFileSync(gh, "#!/bin/sh\nexit 1\n"); chmodSync(gh, 0o700);
    writeFileSync(ps, `#!/bin/sh\ncat > ${quote(observed)}\ncat ${quote(account)}\n`); chmodSync(ps, 0o700);
    for (const name of ["cat", "tr"]) symlinkSync(Bun.which(name)!, join(bin, name));
    const env = { PATH: bin, HOME: root, MISE_DATA_DIR: join(root, "no-installs"), WSL_DISTRO_NAME: "Ubuntu-fixture" };
    const read = () => Bun.spawnSync([Bun.which("sh")!, script], { env, stdout: "pipe", stderr: "pipe" });
    for (const accountName of ["fixture-windows-one", "fixture-windows-two"]) {
      writeFileSync(account, accountName + "\r\n"); const r = read(); expect(r.exitCode).toBe(0); expect(r.stdout.toString().trim()).toBe(accountName);
    }
    expect(readFileSync(observed, "utf8")).toContain("Get-Command gh.exe");
    expect(readFileSync(observed, "utf8")).not.toContain("mise which");
    rmSync(observed); writeFileSync(gh, "#!/bin/sh\nprintf '%s\\n' fixture-linux-account\n");
    const r = read(); expect(r.exitCode).toBe(0); expect(r.stdout.toString().trim()).toBe("fixture-linux-account"); expect(existsSync(observed)).toBe(false);
  });
});
