/** Isolate a single gh: install end to end, with timing per phase. */
import { ghInstall } from "../src/providers.ts";

const repo = process.argv[2] ?? "starship/starship";
const glob = process.argv[3] ?? "starship-x86_64-unknown-linux-gnu.tar.gz";

const t0 = performance.now();
try {
  await ghInstall(repo, glob);
  console.log(`DONE in ${Math.round(performance.now() - t0)}ms`);
} catch (err) {
  console.log(`FAILED after ${Math.round(performance.now() - t0)}ms`);
  console.log((err as Error).message);
}
