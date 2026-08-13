/**
 * Provisioning is unattended all the way down, not only at red-dev's first
 * child. Package managers routinely spawn lifecycle scripts and installers;
 * those grandchildren must inherit the same refusal to ask questions.
 */

import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnLoggedCapture } from "./providers.ts";
import {
  tlsTrustFailure,
  unattendedEnvironment,
  unattendedShellCommand,
} from "./unattended.ts";

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
  npm_config_strict_ssl: "true",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  NODE_USE_SYSTEM_CA: "1",
  DENO_TLS_CA_STORE: "system,mozilla",
  UV_SYSTEM_CERTS: "true",
  UV_NATIVE_TLS: "true",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  POETRY_NO_INTERACTION: "1",
  MISE_YES: "1",
  MISE_SYSTEM_DEPS: "auto",
  YARN_PREFER_INTERACTIVE: "false",
} as const;

describe("the unattended provisioning envelope", () => {
  test("translates intercepted TLS failures into the machine-trust remedy", () => {
    const remedy = "TLS certificate chain is not trusted — install the corporate CA in the machine trust store, then re-run red-dev";
    expect(tlsTrustFailure("npm error SELF_SIGNED_CERT_IN_CHAIN")).toBe(remedy);
    expect(tlsTrustFailure("invalid peer certificate: UnknownIssuer")).toBe(remedy);
    expect(tlsTrustFailure("unable to get local issuer certificate")).toBe(remedy);
    expect(tlsTrustFailure("npm exited non-zero")).toBeNull();
  });

  test("trusts a private CA from the machine without disabling TLS verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "red-dev-ca-"));
    const key = join(dir, "ca.key");
    const cert = join(dir, "ca.pem");
    let server: ReturnType<typeof Bun.serve> | undefined;
    const runNode = async (probe: string, env: Record<string, string | undefined>) => {
      const child = Bun.spawn(["node", "-e", probe], { env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { stdout, stderr, code };
    };
    try {
      const generated = Bun.spawnSync([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost",
        "-addext", "subjectAltName=DNS:localhost",
      ], { stdout: "ignore", stderr: "ignore" });
      expect(generated.exitCode).toBe(0);
      chmodSync(key, 0o600);

      server = Bun.serve({
        port: 0,
        tls: { key: Bun.file(key), cert: Bun.file(cert) },
        fetch: () => new Response("trusted"),
      });
      const probe = `fetch(${JSON.stringify(`https://localhost:${server.port}`)})` +
        `.then(async r => { console.log(await r.text()) })` +
        `.catch(e => { console.error(e.cause?.code ?? e.code ?? e.message); process.exit(2) })`;
      const plain = await runNode(probe, {
        ...process.env,
        NODE_USE_SYSTEM_CA: "0",
        SSL_CERT_FILE: undefined,
      });
      expect(plain.code).toBe(2);

      const trusted = await runNode(
        probe,
        unattendedEnvironment(process.env, { SSL_CERT_FILE: cert }),
      );
      expect(trusted.code).toBe(0);
      expect(trusted.stdout.trim()).toBe("trusted");

      const trustedEnvironment = unattendedEnvironment({}, { SSL_CERT_FILE: cert });
      expect(trustedEnvironment["npm_config_strict_ssl"]).toBe("true");
      expect(trustedEnvironment["npm_config_cafile"]).toBe(cert);
      expect(trustedEnvironment["NODE_EXTRA_CA_CERTS"]).toBe(cert);
      expect(trustedEnvironment["CURL_CA_BUNDLE"]).toBe(cert);
      expect(trustedEnvironment["REQUESTS_CA_BUNDLE"]).toBe(cert);
      expect(trustedEnvironment["PIP_CERT"]).toBe(cert);
      expect(trustedEnvironment["GIT_SSL_CAINFO"]).toBe(cert);
    } finally {
      server?.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

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
    for (const name of [
      "SSL_CERT_FILE",
      "CURL_CA_BUNDLE",
      "NODE_EXTRA_CA_CERTS",
      "REQUESTS_CA_BUNDLE",
      "PIP_CERT",
      "GIT_SSL_CAINFO",
      "npm_config_cafile",
    ]) {
      expect(command).toContain(`${name}='/etc/ssl/certs/ca-certificates.crt'`);
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
