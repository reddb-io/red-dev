/**
 * The environment contract for provisioning children.
 *
 * stdin=ignore prevents a prompt from stealing the TUI's keyboard, but EOF is
 * only a last line of defence. Package managers and their lifecycle children
 * should be told explicitly that nobody will answer. Environment inheritance
 * then carries this contract through second- and third-level installers.
 */

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
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",

  // Python and mise runtime/plugin installers.
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  POETRY_NO_INTERACTION: "1",
  MISE_YES: "1",
  MISE_SYSTEM_DEPS: "auto",

  // Yarn Berry's documented prompt preference. Classic Yarn also observes CI.
  YARN_PREFER_INTERACTIVE: "false",
} as const satisfies Record<string, string>;

/** Merge caller-specific values, then enforce the unattended contract. */
export function unattendedEnvironment(
  current: Record<string, string | undefined> = process.env,
  extra: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return { ...current, ...extra, ...UNATTENDED_ENV };
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
  const assignments = Object.entries({ ...extra, ...UNATTENDED_ENV })
    .map(([name, value]) => `${name}=${shellWord(value)}`)
    .join(" ");
  return `env ${assignments} ${command}`;
}
