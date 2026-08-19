/**
 * The Ubuntu 24 offline depot journey, as a command.
 *
 * `bun run e2e:offline-ubuntu24` — export a depot on a connected machine,
 * import it onto a clean network-denied Ubuntu 24.04 x64 target, and
 * prove a second converge writes nothing. Every check is printed, and a
 * failed one exits non-zero, so this is the same claim the test asserts
 * rather than a second opinion about it.
 *
 * `--keep` leaves both machines behind for inspection; without it the
 * temporary directories go away whether the journey passed or failed.
 */
import { journeyLines, runUbuntu24OfflineJourney } from "../src/offline-depot-e2e.ts";

const keep = process.argv.includes("--keep");
const result = await runUbuntu24OfflineJourney({ keep });

for (const line of journeyLines(result)) console.log(line);
if (result.root !== null) console.log(`kept at ${result.root}`);

process.exit(result.ok ? 0 : 1);
