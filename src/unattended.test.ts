/**
 * Provisioning is unattended all the way down, not only at red-dev's first
 * child. Package managers routinely spawn lifecycle scripts and installers;
 * those grandchildren must inherit the same refusal to ask questions.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { spawnLoggedCapture } from "./providers.ts";
import { unattendedShellCommand } from "./unattended.ts";

const expected = {
  RED_DEV_UNATTENDED: "1",
  CI: "1",
  NONINTERACTIVE: "1",
  DEBIAN_FRONTEND: "noninteractive",
  APT_LISTCHANGES_FRONTEND: "none",
  NEEDRESTART_MODE: "a",
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  npm_config_yes: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_progress: "false",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  POETRY_NO_INTERACTION: "1",
  MISE_YES: "1",
  MISE_SYSTEM_DEPS: "auto",
  YARN_PREFER_INTERACTIVE: "false",
} as const;

describe("the unattended provisioning envelope", () => {
  test("survives a package manager and reaches its lifecycle child", async () => {
    const names = Object.keys(expected);
    const grandchild =
      `console.log(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(k => [k, process.env[k] ?? null]))))`;
    const manager =
      `const p = Bun.spawnSync([process.execPath, "-e", ${JSON.stringify(grandchild)}], { stdout: "pipe" });` +
      `process.stdout.write(p.stdout); process.exit(p.exitCode);`;

    const result = await spawnLoggedCapture([process.execPath, "-e", manager], {
      // A caller and its ambient shell cannot weaken the contract.
      env: { ...process.env, CI: "0", npm_config_yes: "false", CUSTOM_ENV: "kept" },
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.trim())).toEqual(expected);
  });

  test("is explicitly carried across the Windows to WSL boundary", () => {
    const source = readFileSync(`${import.meta.dir}/wsl-sync.ts`, "utf8");

    expect(source).toContain("unattendedShellCommand(");
    expect(source).not.toContain('"red-dev install core",');

    const command = unattendedShellCommand("red-dev install core");
    for (const [name, value] of Object.entries(expected)) {
      expect(command).toContain(`${name}='${value}'`);
    }
  });

  test("survives our Linux privilege boundary before apt and dpkg", () => {
    const providers = readFileSync(`${import.meta.dir}/providers.ts`, "utf8");
    const ssh = readFileSync(`${import.meta.dir}/ssh-server.ts`, "utf8");

    expect(providers).not.toContain('["sudo", "apt-get", "install"');
    expect(providers).toContain('["sudo", "-E", "apt-get", "install"');
    expect(providers).toContain('exec ${quoted} -E "$@"');
    expect(ssh).toContain('"-n",\n    "-E",\n    "apt-get"');
  });
});
