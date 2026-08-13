/**
 * The environment contract for provisioning children.
 *
 * stdin=ignore prevents a prompt from stealing the TUI's keyboard, but EOF is
 * only a last line of defence. Package managers and their lifecycle children
 * should be told explicitly that nobody will answer. Environment inheritance
 * then carries this contract through second- and third-level installers.
 */

import { existsSync } from "node:fs";

const LINUX_SYSTEM_CA_BUNDLE = "/etc/ssl/certs/ca-certificates.crt";

export const UNATTENDED_ENV = {
  RED_DEV_UNATTENDED: "1",
  // Widely understood by JS package managers and lifecycle scripts.
  CI: "1",
  NONINTERACTIVE: "1",

  // Debian packages, apt-listchanges and needrestart.
  DEBIAN_FRONTEND: "noninteractive",
  APT_LISTCHANGES_FRONTEND: "none",
  NEEDRESTART_MODE: "a",

  // Git and Git Credential Manager must fail instead of opening a prompt/UI.
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",

  // npm settings are inherited by lifecycle scripts and are also understood
  // by pnpm where it follows npm's configuration surface.
  // Lowercase is intentional. npm accepts either spelling at its own CLI,
  // but documents that lifecycle scripts prefer the lowercase variables it
  // creates internally. Starting lowercase prevents an inherited user value
  // from winning at that second hop.
  npm_config_yes: "true",
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
  npm_config_progress: "false",
  // Keep verification on. Trust comes from the machine's CA store below;
  // accepting every certificate would turn a corporate proxy fix into a
  // silent man-in-the-middle vulnerability.
  npm_config_strict_ssl: "true",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",

  // Node 22.19+/24.6+ adds the OS trust store to its bundled Mozilla roots.
  // npm and its lifecycle descendants inherit this automatically.
  NODE_USE_SYSTEM_CA: "1",

  // Deno otherwise defaults to Mozilla roots only.
  DENO_TLS_CA_STORE: "system,mozilla",

  // uv otherwise uses its bundled Mozilla roots. System certificates are
  // required for managed workstations whose proxy CA lives in the OS store.
  // Keep the legacy spelling too: older uv releases used it and vendor
  // installers may bring their own uv binary.
  UV_SYSTEM_CERTS: "true",
  UV_NATIVE_TLS: "true",

  // Python and mise runtime/plugin installers.
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  POETRY_NO_INTERACTION: "1",
  MISE_YES: "1",
  MISE_SYSTEM_DEPS: "auto",

  // Yarn Berry's documented prompt preference. Classic Yarn also observes CI.
  YARN_PREFER_INTERACTIVE: "false",
} as const satisfies Record<string, string>;

const UNTRUSTED_TLS_CHAIN =
  /SELF_SIGNED_CERT_IN_CHAIN|self[- ]signed certificate in certificate chain|UnknownIssuer|unknown issuer|unable to get local issuer certificate|unable to verify the first certificate|certificate signed by unknown authority/i;

/** Turn the common corporate-proxy TLS failures into one actionable error. */
export function tlsTrustFailure(output: string): string | null {
  if (!UNTRUSTED_TLS_CHAIN.test(output)) return null;
  return "TLS certificate chain is not trusted — install the corporate CA in the machine trust store, then retry red-dev";
}

/**
 * Point OpenSSL/npm/Bun at the CA bundle maintained by update-ca-certificates.
 *
 * Windows has no PEM bundle to name: NODE_USE_SYSTEM_CA and Deno's `system`
 * store read the Windows Certificate Store directly, while native curl uses
 * Schannel. On Linux and WSL, the bundle contains both public roots and any
 * private CA the administrator installed into the machine trust chain.
 */
function machineTrustEnvironment(
  current: Record<string, string | undefined>,
): Record<string, string> {
  if (process.platform === "win32") return {};
  const cafile = current["SSL_CERT_FILE"] ??
    (existsSync(LINUX_SYSTEM_CA_BUNDLE) ? LINUX_SYSTEM_CA_BUNDLE : undefined);
  if (!cafile) return {};
  return {
    ...(current["SSL_CERT_FILE"] ? {} : { SSL_CERT_FILE: cafile }),
    ...(current["CURL_CA_BUNDLE"] ? {} : { CURL_CA_BUNDLE: cafile }),
    ...(current["NODE_EXTRA_CA_CERTS"] ? {} : { NODE_EXTRA_CA_CERTS: cafile }),
    ...(current["REQUESTS_CA_BUNDLE"] ? {} : { REQUESTS_CA_BUNDLE: cafile }),
    ...(current["PIP_CERT"] ? {} : { PIP_CERT: cafile }),
    ...(current["GIT_SSL_CAINFO"] ? {} : { GIT_SSL_CAINFO: cafile }),
    ...(current["npm_config_cafile"] ? {} : { npm_config_cafile: cafile }),
  };
}

/** Merge caller-specific values, then enforce the unattended contract. */
export function unattendedEnvironment(
  current: Record<string, string | undefined> = process.env,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  const merged = { ...current, ...extra };
  return { ...merged, ...machineTrustEnvironment(merged), ...UNATTENDED_ENV };
}

function shellWord(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Carry the same environment across `wsl.exe`, which does not promise to
 * forward arbitrary Windows variables into the distro.
 */
export function unattendedShellCommand(
  command: string,
  extra: Record<string, string> = {},
): string {
  // This function's destination is always an Ubuntu WSL distro. Its bundle
  // cannot be discovered from the Windows host where this string is built.
  const assignments = Object.entries({
    SSL_CERT_FILE: LINUX_SYSTEM_CA_BUNDLE,
    CURL_CA_BUNDLE: LINUX_SYSTEM_CA_BUNDLE,
    NODE_EXTRA_CA_CERTS: LINUX_SYSTEM_CA_BUNDLE,
    REQUESTS_CA_BUNDLE: LINUX_SYSTEM_CA_BUNDLE,
    PIP_CERT: LINUX_SYSTEM_CA_BUNDLE,
    GIT_SSL_CAINFO: LINUX_SYSTEM_CA_BUNDLE,
    npm_config_cafile: LINUX_SYSTEM_CA_BUNDLE,
    ...extra,
    ...UNATTENDED_ENV,
  })
    .map(([name, value]) => `${name}=${shellWord(value)}`)
    .join(" ");
  return `env ${assignments} ${command}`;
}
