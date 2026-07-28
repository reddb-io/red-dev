/**
 * Isolate the gh: provider's asset resolution. Run against each new
 * tool to find which one spins, rather than bisecting a whole converge.
 */
import { resolveGhAsset } from "../src/providers.ts";

const CASES: [string, string][] = [
  ["starship/starship", "starship-x86_64-unknown-linux-gnu.tar.gz"],
  ["atuinsh/atuin", "atuin-x86_64-unknown-linux-musl.tar.gz"],
  ["carapace-sh/carapace-bin", "carapace-bin_*_linux_amd64.deb"],
];

for (const [repo, glob] of CASES) {
  const t0 = performance.now();
  try {
    const url = await resolveGhAsset(repo, glob);
    console.log(`OK   ${repo} (${Math.round(performance.now() - t0)}ms)`);
    console.log(`     ${url.split("/").pop()}`);
  } catch (err) {
    console.log(`FAIL ${repo} (${Math.round(performance.now() - t0)}ms)`);
    console.log(`     ${(err as Error).message.split("\n")[0]}`);
  }
}
