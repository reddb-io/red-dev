/**
 * The Ubuntu 26 offline journey, as a command.
 *
 * `bun run e2e:offline-ubuntu26` — refuse another machine's builds,
 * export a depot on a connected machine, import it onto a clean
 * network-denied Ubuntu 26.04 x64 target, move it forward, hold an
 * update that did not verify, roll the whole workstation back, take it
 * off again, and prove Ubuntu 24 answers the same checks the same way.
 * Every check is printed, and a failed one exits non-zero, so this is
 * the same claim the test asserts rather than a second opinion about it.
 *
 * `--keep` leaves the machines behind for inspection; without it the
 * temporary directories go away whether the journey passed or failed.
 */
import { runUbuntu26Journey, ubuntu26JourneyLines } from "../src/ubuntu26-e2e.ts";

const keep = process.argv.includes("--keep");
const result = await runUbuntu26Journey({ keep });

for (const line of ubuntu26JourneyLines(result)) console.log(line);
if (result.root !== null) console.log(`kept at ${result.root}`);

process.exit(result.ok ? 0 : 1);
