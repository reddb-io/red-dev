import { runBounded, type BoundedCommandResult } from "./bounded-command.ts";
import type { Invocation } from "./cli.ts";
import { log } from "./log.ts";
import { miseToolBin } from "./mise-config.ts";
import { compareVersions } from "./self-update.ts";

/** The newly installed binary owns convergence; never run the suite twice. */
export async function convergeUpdatedBinary(
  current: string,
  inv: Pick<Invocation, "yes" | "dryRun">,
  fallback: () => Promise<number>,
  deps: {
    locate?: () => string | null;
    probe?: (path: string) => Promise<BoundedCommandResult>;
    run?: (path: string, argv: string[]) => Promise<number>;
  } = {},
): Promise<number> {
  if (inv.dryRun) return fallback();
  const path = (deps.locate ?? (() => miseToolBin("red-dev")))();
  if (!path) return fallback();
  // `latest` can now point at new bytes while this process executes its old
  // inode. Path equality cannot decide whether a handover is needed.
  const probe = await (deps.probe ?? (binary => runBounded([binary, "--version"], { timeoutMs: 5_000 })))(path);
  if (probe.timedOut || probe.exitCode !== 0) throw new Error("cannot verify the installed red-dev — refusing convergence through the older binary");
  const version = probe.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) throw new Error("installed red-dev returned an invalid version");
  if (compareVersions(version, current) <= 0) return fallback();
  log.info(`converging through installed red-dev ${version}`);
  const argv = ["install", ...(inv.yes ? ["--yes"] : [])];
  const run = deps.run ?? (async (binary: string, args: string[]) => {
    const { spawnLogged } = await import("./providers.ts");
    return spawnLogged([binary, ...args], { env: { RED_DEV_UPDATE_CONVERGE: "1" } });
  });
  return run(path, argv);
}
