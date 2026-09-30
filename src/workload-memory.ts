import { runBounded, type BoundedCommandResult } from "./bounded-command.ts";

export type MemoryCommand = (argv: string[]) => Promise<BoundedCommandResult>;

/** Retire red-dev limits on live scopes; never restart a process. */
export async function releaseWorkloadMemoryLimits(
  run: MemoryCommand = (argv) => runBounded(argv, { timeoutMs: 5_000 }),
): Promise<{ released: string[]; failed: string[] }> {
  const released: string[] = [];
  const failed: string[] = [];
  const listed = await run(["systemctl", "--user", "list-units", "--all", "--type=slice,scope,service", "--output=json", "--no-pager"]);
  if (listed.exitCode !== 0 || listed.timedOut) return { released, failed: ["list-units"] };
  let units: unknown;
  try { units = JSON.parse(listed.stdout); }
  catch { return { released, failed: ["list-units"] }; }
  if (!Array.isArray(units)) return { released, failed: ["list-units"] };
  for (const row of units) {
    const unit: unknown = row?.unit;
    if (typeof unit !== "string" || !/^(?:red-dev(?:-[a-z]+)*\.slice|run-[a-z0-9]+\.scope|red-worker-.+\.service)$/.test(unit)) continue;
    const observed = await run(["systemctl", "--user", "show", unit, "--property=ControlGroup,MemoryHigh,MemoryMax,MemorySwapMax"]);
    if (observed.exitCode !== 0 || observed.timedOut) { failed.push(unit); continue; }
    const props = Object.fromEntries(observed.stdout.trim().split("\n").map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }));
    // A similarly named scope outside our hierarchy belongs to somebody else.
    if (!/(?:^|\/)red-dev\.slice(?:\/|$)/.test(props["ControlGroup"] ?? "")) continue;
    if (["MemoryHigh", "MemoryMax", "MemorySwapMax"].every((key) => props[key] === "infinity")) continue;
    const result = await run(["systemctl", "--user", "set-property", "--runtime", unit,
      "MemoryHigh=infinity", "MemoryMax=infinity", "MemorySwapMax=infinity"]);
    (result.exitCode === 0 && !result.timedOut ? released : failed).push(unit);
  }
  return { released, failed };
}
