import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "./migrations.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

test.skipIf(process.platform === "win32")("fresh and legacy machines run the real preparation with exact backups and preserved choices", async () => {
  for (const legacy of [false, true]) {
    const root = mkdtempSync(join(tmpdir(), "red-provisioning-")); roots.push(root);
    const config = join(root, ".config");
    const state = join(root, "state");
    const mise = join(config, "mise");
    const preferences = join(config, "alacritty", "red-dev.json");
    const personal = join(mise, "config.toml");
    mkdirSync(join(config, "alacritty"), { recursive: true });
    mkdirSync(mise, { recursive: true });
    mkdirSync(join(state, "red-dev"), { recursive: true });
    const original = '[tools]\r\n"github:reddb-io/toon" = "latest"\r\nnode = "lts"\r\ncustom = "my-choice"\r\n';
    const preferencesBytes = '{"agents":["opencode","gemini","codex"],"runtimes":["node@lts"],"apps":["antigravity"],"custom":"preserve"}\n';
    if (legacy) {
      writeFileSync(personal, original);
      writeFileSync(preferences, preferencesBytes);
    }
    // Isolate the historical duplicate-identity repair; no vendor or network
    // subprocess is allowed. Its replacement proof uses this fixture mise.
    const bin = join(root, "bin"); mkdirSync(bin);
    writeFileSync(join(bin, "mise"), '#!/bin/sh\n[ "$1" = "where" ] && [ "$2" = "tq" ]\n', { mode: 0o755 });
    writeFileSync(join(state, "red-dev", "migrations.json"), JSON.stringify({ schema: 1,
      applied: MIGRATIONS.filter(m => m.id !== "2026-09-22-single-mise-identity").map(m => m.id) }));
    const script = `
      import { prepareProvisioning } from "./src/provisioning.ts";
      import { readMachineProfile } from "./src/machine-profile.ts";
      const p = { os: "linux", env: "desktop", distro: "ubuntu", version: "26.04", arch: "x64",
        caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false } };
      await prepareProvisioning(p);
      await prepareProvisioning(p);
      console.log("RESULT " + JSON.stringify(readMachineProfile()));
    `;
    const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe", env: {
      ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: config, XDG_STATE_HOME: state,
      MISE_CONFIG_DIR: mise, MISE_CONFIG_FILE: personal, MISE_DATA_DIR: join(root, "mise-data"),
      RED_DEV_PROFILE_FILE: join(root, "profile.json"), RED_DEV_POLICY_FILE: join(root, "policies.json"),
      RED_DEV_UPDATE_CLOCK: "", RED_DEV_UPDATE_LEASE: "", RED_DEV_WSL_CHILD: "", RED_DEV_WSL_PROFILE: "",
      PATH: bin, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
    } });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect([code, stderr]).toEqual([0, ""]);
    expect(stdout).not.toContain("failed");
    const recorded = JSON.parse(stdout.split("\n").find(line => line.startsWith("RESULT "))!.slice(7));
    expect(recorded.name).toBe("ubuntu-desktop");
    expect(recorded.resources).toBeUndefined();
    const fragment = readFileSync(join(mise, "conf.d", "10-reddb-io.toml"), "utf8");
    expect(fragment).toContain("credential_command");
    expect(fragment).toContain("red-dev-github-auth.sh");
    if (legacy) {
      expect(readFileSync(preferences, "utf8")).toBe(preferencesBytes);
      expect(readFileSync(`${personal}.bak-red-dev-single-identity`, "utf8")).toBe(original);
      const remaining = readFileSync(personal, "utf8");
      expect(remaining).not.toContain("github:reddb-io/toon");
      expect(remaining).toContain('node = "lts"');
      expect(remaining).toContain('custom = "my-choice"');
      expect(recorded.agents).toEqual(["redcode", "codex"]);
      expect(recorded.apps).toEqual(["antigravity"]);
      expect(recorded.runtimes).toEqual(["node@lts"]);
    } else {
      expect(readdirSync(mise)).not.toContain("config.toml");
    }
  }
});
