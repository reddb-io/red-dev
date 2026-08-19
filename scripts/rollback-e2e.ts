/**
 * The Ubuntu 24 rollback journey, as a command.
 *
 * `bun run e2e:rollback-ubuntu24` — provision a network-denied Ubuntu
 * 24.04 x64 target across three complete revisions, hold a prune through
 * an update that did not verify, roll the whole workstation back to the
 * previous complete lock with no network and nothing terminated, and
 * prove a second rollback writes nothing. Every check is printed, and a
 * failed one exits non-zero, so this is the same claim the test asserts
 * rather than a second opinion about it.
 *
 * `--keep` leaves the machines behind for inspection; without it the
 * temporary directories go away whether the journey passed or failed.
 */
import { rollbackJourneyLines, runUbuntu24RollbackJourney } from "../src/rollback-e2e.ts";

const keep = process.argv.includes("--keep");
const result = await runUbuntu24RollbackJourney({ keep });

for (const line of rollbackJourneyLines(result)) console.log(line);
if (result.root !== null) console.log(`kept at ${result.root}`);

process.exit(result.ok ? 0 : 1);
