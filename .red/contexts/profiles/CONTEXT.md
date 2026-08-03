# Context: profiles

Machine intent — what an installation must contain and how "ready" is enforced.

## Profile

A versioned declaration of machine intent: the set of items an installation must converge. The profile mechanism is neutral; taste (which items) lives in each profile, not in the core.

## reddb-employee

The only profile with a known user and an enforceable definition of done. Tiered baseline: a **required** core (the full RedDB stack — `red`, `tq`, red-request, `dit`, red-ui, RedSkills — plus Docker, mise runtimes, and a default agent host), with every additional catalog item explicitly marked **recommended** or **experimental**.

## Requirement tiers

Every profile item belongs to exactly one tier: **required** (readiness enforces 100%), **recommended** (installed by default, can be declined), or **experimental** (opt-in, never counts against readiness).

## Readiness report

The result that closes a profile convergence. Distinguishes per item: `healthy`, `auth-required` (pending human action, not a failure), `unsupported-with-reason`, `failed`, and `not-chosen`. "Ready" = 100% of required items in `healthy` or `auth-required`. Born machine-readable (`doctor --json`).

## Development databases

red-dev installs no databases and no database containers — an explicit decision against the Omakub-style module. The required stack already contains RedDB (the `red` binary) and Docker; any additional service is the developer's responsibility, via Docker.
