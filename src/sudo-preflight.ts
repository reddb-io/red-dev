/**
 * Authenticate sudo before a human install enters fullscreen mode.
 *
 * Providers deliberately use `sudo -n`: once the renderer owns stdin, a
 * password prompt is hidden work and can hang forever. A visible `sudo -v`
 * before render preserves that non-interactive provider contract while still
 * letting an ordinary Ubuntu install finish in one run.
 */

import {
  installState,
  providerFor,
  toolsInScope,
  type InstallState,
  type Provider,
  type Scope,
  type Tool,
} from "./manifest.ts";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";

/** Whether a Linux provider will need a warm sudo credential. PURE. */
export function providerUsesSudo(provider: Provider): boolean {
  if (provider.needsSudo === true) return true;
  if (provider.kind === "apt" || provider.kind === "ppa" || provider.kind === "aptrepo") {
    return true;
  }
  return provider.kind === "gh" && /\.deb$/i.test(provider.asset);
}

/** Pending items that would otherwise all become deferred inside the TUI. PURE with injected state. */
export function sudoItemsFor(
  platform: Platform,
  scopes: readonly Scope[],
  state: (tool: Tool) => InstallState = installState,
): string[] {
  if (platform.os !== "linux") return [];
  return scopes
    .flatMap((scope) => toolsInScope(scope))
    // Managed providers deliberately probe inside their implementation, so
    // installState reports them pending forever. Including one here would ask
    // for a password on every already-converged run. Ordinary package and
    // installer rows have an honest pre-render presence state and are enough
    // to cover a fresh Ubuntu machine.
    .filter((tool) => !tool.managed)
    .filter((tool) => state(tool) !== "ok" && providerUsesSudo(providerFor(tool, platform)))
    .map((tool) => tool.name);
}

export interface SudoPrimeOptions {
  uid?: () => number;
  run?: (argv: string[]) => Promise<number>;
}

const runAttached = async (argv: string[]): Promise<number> => {
  try {
    const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    return await child.exited;
  } catch {
    return 127;
  }
};

/** Ask once, in the ordinary terminal, before any fullscreen frame exists. */
export async function primeSudoInteractive(options: SudoPrimeOptions = {}): Promise<boolean> {
  const uid = options.uid ?? (() => process.getuid?.() ?? -1);
  if (uid() === 0) return true;

  log.step("sudo: authenticate once for system packages before the installer opens");
  const code = await (options.run ?? runAttached)(["sudo", "-v"]);
  if (code === 0) return true;

  log.warn("sudo was not authenticated — system packages will be deferred, not hidden");
  return false;
}
