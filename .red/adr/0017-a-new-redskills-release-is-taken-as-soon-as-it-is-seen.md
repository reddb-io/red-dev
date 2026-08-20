# 0017 — A new RedSkills release is taken as soon as it is seen

- Status: accepted
- Date: 2026-08-20
- Contexts: `lifecycle`, `agents`
- Refines: ADR 0010 (one RedSkills package set per workstation), ADR 0012 (acquisition is one implementation)
- Follows: ADR 0009 (the Redwall is repainted by a host hook, not a timer)
- Sources: the night of 2026-08-19, and what it cost

## Context

RedSkills publishes often. A workstation learns about it when somebody
remembers to type `red-dev update`, and nothing else ever asks. On 2026-08-19
this machine sat on 3.22.0 for most of a day with 4.0.1 published, while the
person using it had no way to know: the CLIs were wired to a revision four
months of work behind the one on disk at the publisher, and the only signal
was a command nobody had a reason to run.

The parts needed to do better already exist and are cheap:

- **Asking is one round trip.** `acquireRedSkills` resolves a channel with
  `git ls-remote --tags` and compares the resolved commit against the active
  identity before it clones, downloads or verifies anything
  (`src/red-skills-acquire.ts`). A machine already on the newest commit
  answers `current` for the cost of one request — no API, no token, no rate
  limit.
- **Taking it safely is already implemented.** `src/staged-update.ts` acquires,
  verifies, and holds the complete revision back while a Worker is running,
  activating it when none is.

What was missing was not machinery. It was a trigger.

## Decision

**A machine takes a new release as soon as it sees one.** Not "offers to",
not "reports that one exists": acquires it, verifies the signature, activates
it and reconciles every host, without being asked. The person's next session
is on the new revision because the machine already did the work.

**Seeing is a cheap question, asked on an event, never on a timer.** ADR 0009
settled the shape for the Redwall and the argument is the same one: a timer on
an idle machine is a process spawned to learn that nothing moved, and this
machine has already paid for that mistake once. The question rides two things
that happen anyway — the host hook the daemon fires when a Worker is born, and
a shell starting — and is debounced by a stamp so that the network is touched
at most once per interval no matter how many triggers fire.

**A Worker still holds the revision.** Aggressive means "take it now", not
"swap the tree under something using it". A run that meets a Worker stages the
complete verified revision and activates it the moment none is running, which
is ADR 0010's rule unchanged. The aggression is in when we *look* and how
little we wait afterwards, never in what we are willing to break.

**One run at a time, machine-wide.** Two terminals opening together must not
become two acquisitions. A lock with an expiry guards the whole check-and-take,
so a second trigger returns immediately rather than queueing behind the first.

**Nothing about verification moves.** The signature is checked exactly as it
is for a typed `red-dev red-skills install`; this record changes who starts the
acquisition, and nothing about what the acquisition is willing to accept.

## Consequences

- A machine tracks the publisher within a session start rather than within
  however long it takes somebody to remember. The 24-hour-stale workstation
  stops being the normal case.
- A release that is bad is taken quickly too. The mitigations are the ones
  already in place and are the reason this is defensible: the signature is
  verified before `current` moves, the previous revision is retained and
  `red-dev red-skills rollback` restores it, and the version pin is a major
  (`REDSKILLS_MAJOR` in `src/manifest.ts`) so a major boundary is still a
  decision a person makes in a commit.
- Background work costs something on a machine that is being used, and nothing
  on one that is not — which is the opposite of the timer this replaces.
- The check needs the network. An offline machine answers "could not ask" and
  carries on; it is not an error, and it is not reported as one.
