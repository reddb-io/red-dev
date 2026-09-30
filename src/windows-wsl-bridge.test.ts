import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { bridgeCmd, bridgePowerShell } from "./windows-wsl-migration.ts";
import { MISE_GITHUB_AUTH_PS1 } from "./mise-github.ts";

const ps = (word: string) => `'${word.replaceAll("'", "''")}'`;
test.skipIf(process.platform !== "win32")("PowerShell 5.1 bridges preserve bash quotes, user arguments, cwd and exit status", () => {
  const root = mkdtempSync(join(tmpdir(), "red-dev Windows boundary "));
  try {
    const capture = join(root, "argv.json"), source = join(root, "fake-wsl.ts"), exe = join(root, "wsl.exe");
    writeFileSync(source, 'await Bun.write(process.env.RED_DEV_BRIDGE_OUTPUT!, JSON.stringify(process.argv.slice(2))); process.exit(7);');
    expect(Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", exe]).exitCode).toBe(0);
    const script = join(root, "redskilled-wsl.ps1"); writeFileSync(script, bridgePowerShell("Ubuntu's distro", "redskilled", exe));
    const env: NodeJS.ProcessEnv = { ...process.env, RED_DEV_BRIDGE_OUTPUT: capture };
    const inheritedPath = process.env.PATH ?? process.env.Path ?? "";
    for (const key of Object.keys(env)) if (key.toLowerCase() === "path") delete env[key];
    env.Path = `${root};${inheritedPath}`;
    const args = ["path with spaces", 'embedded"quote', "apostrophe's", "C:\\trailing\\", "$(literal)", "", "--verbose"];
    const result = Bun.spawnSync(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `& ${ps(script)} ${args.map(ps).join(" ")}`], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    expect({ stderr: result.stderr.toString(), stdout: result.stdout.toString(), code: result.exitCode }).toEqual({ stderr: "", stdout: "", code: 7 });
    expect(JSON.parse(readFileSync(capture, "utf8"))).toEqual(["-d", "Ubuntu's distro", "--cd", root, "--", "bash", "-lc", 'exec redskilled "$@"', "redskilled", ...args]);
    const batch = join(root, "redskilled.cmd"); writeFileSync(batch, bridgeCmd(script));
    const cmd = Bun.spawnSync(["cmd.exe", "/c", batch, "simple", "two words"], { env, cwd: root, stdout: "pipe", stderr: "pipe" });
    expect(cmd.exitCode).toBe(7); expect(JSON.parse(readFileSync(capture, "utf8")).slice(-2)).toEqual(["simple", "two words"]);

    // Verify the persistent helper against a real native executable, too.
    writeFileSync(source, 'if (process.argv.slice(2).join(" ") !== "auth token --hostname github.com") process.exit(3); console.log("fixture-windows-account");');
    expect(Bun.spawnSync([process.execPath, "build", source, "--compile", "--outfile", join(root, "gh.exe")]).exitCode).toBe(0);
    const auth = join(root, "github-auth.ps1"); writeFileSync(auth, MISE_GITHUB_AUTH_PS1);
    const token = Bun.spawnSync(["powershell.exe", "-NoProfile", "-NonInteractive", "-File", auth], { env, stdout: "pipe", stderr: "pipe" });
    expect(token.exitCode).toBe(0); expect(token.stdout.toString().trim()).toBe("fixture-windows-account");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 60_000);
