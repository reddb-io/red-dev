# 0009 — The Redwall is repainted by a host hook, not a timer

- Status: accepted
- Date: 2026-08-16
- Contexts: `visual`, `agents`, `lifecycle`
- Sources: red-skills ADR 0140 *The host hook is the event lane, and the daemon never dials out*, with Amendments 1 and 2; red-dev#63; red-dev ADR 0004 Amendment 2

## Context

A Redwall draws the live Worker count over the theme's art. The count only moves
when a Worker is born or dies, and both are events the RedSkills daemon already
knows about — but until this record red-dev had no way to hear them, so the
image was kept current by a two-minute systemd timer and a per-minute Windows
scheduled task (`redwall-schedule.ts`).

A timer is the wrong shape for a fact that changes rarely. On an idle machine
every tick was a process spawned to learn that nothing had moved; on a busy one
the desktop was wrong for up to two minutes at a time. The cost was paid where
it was least wanted: a WSL distro's timer had to cross into Windows to repaint,
and a console program launched from a supervisor with no console of its own gets
one allocated for it — a black rectangle over the wallpaper, every two minutes,
which is the whole reason `windows-hidden.ts` exists.

red-skills#3503 closed on 2026-08-12 with ADR 0140, which publishes the contract
that removes the need. It offers a consumer two mechanisms: **watch the host
event lane** (`~/.red/redskilled/redskilled.log.toonl`, an append-only file that
survives daemon restart), or **register a host hook** the daemon execs. This
record says which red-dev takes, and answers the one question ADR 0140 says a
consumer must answer rather than discover.

## Decision

**The mechanism is the registered host hook, and never both.** Two mechanisms
repainting one image is worse than either: the second is the one nobody
remembers exists when the picture is wrong. `redwall-schedule.ts` is deleted by
the same change, and a converge removes the units and the scheduled task from
machines that upgrade into this, so no machine is ever between the two.

**The grounds are the WSL boundary.** ADR 0140 decision 6: *the lane is
watchable only from the side that writes it.* File-change notification does not
cross into native Windows, so a Windows-side consumer watching a distro's lane
receives nothing, forever, with no error. red-dev spans that boundary on every
WSL machine it sets up. A hook inverts the direction — the daemon fires, on the
side that writes the lane, and the WSL-side red-dev it starts reaches the
Windows desktop through interop the way it already resolves an address. Nothing
watches across the boundary because nothing watches at all. The second ground is
cost: a lane watcher is a process red-dev would have to keep alive, which means a
supervisor, which is the timer's problem again with a longer-lived process at the
end of it.

**The declaration is machine policy, not a project registration.** ADR 0140
Amendment 1 scopes a hook to the registering project; Amendment 2 adds the
ownership case red-dev actually is — `plugins.dev.redskilled.hooks.<kind>` in the
operator's `~/.red/config.yaml`, fired as an admitted, budgeted, refusable Worker
owned by `redskilled/host-events`. red-dev takes that one because **a
registration is a lease**: five-minute TTL, renewed at its half-life by a live
MCP session. red-dev has no session — it is a command somebody types, or a
converge that runs and exits — so a registration made by `red-dev install` would
lapse five minutes later and leave the desktop showing the state of that moment,
which is the frozen wallpaper this feature exists to prevent. Machine policy is
re-read on every daemon start and survives restart, which is the lifetime a
desktop has. The three properties Amendment 1 demands — an owner, a budget, a
refusal path — are all still present; it is the lease red-dev cannot hold, not
the accountability.

**Three kinds, one argv, no placeholder.** `worker-birth`, `worker-death` and
`worker-budget-kill` — the whole published vocabulary of decision 3 — each keyed
to `red-dev redwall`. The daemon refuses an unrecognised `{{…}}` rather than
starting, and a Redwall draws the machine and not the Worker, so it needs none of
the four facts a birth supplies.

**The record is never drawn from.** The daemon hands the hook the full
`host-state` document on stdin. Per decision 4, a consumer that wants the whole
picture asks `host-state` *after* the event, which is what `redwall.ts` already
does. red-dev reads the payload for exactly one purpose — to say out loud when
it is a version this build cannot parse — and an unreadable record never
withholds a repaint.

**The unwatchable topology is reported, not discovered.** A native-Windows
Redwall merges every running distro's `host-state` into its image by design, so
its count is mostly produced by daemons on the far side of decision 6's boundary.
red-dev still declares the hook there — it covers a Windows-side daemon, and a
partial answer beats none — and says on every converge that a WSL daemon's events
cannot reach it, naming the remedy red-dev already ships: run `red-dev install
core` inside the distro, whose daemon fires the hook on its own side and whose
red-dev repaints this desktop through interop.

**red-dev edits only between its own markers.** `~/.red/config.yaml` is the
operator's file: it carries their host ceilings and their GitHub App, and on the
machines that have one it is heavily commented. Parsing and re-emitting it would
hand back a semantically identical document with every comment gone, which is a
rude way to add four lines. A `hooks:` block red-dev did not write is refused
rather than replaced — an operator declaring their own sink for the same three
kinds is a decision, not a conflict to resolve by force.

## Consequences

- red-dev installs no periodic job on any target. ADR 0004's premise holds again
  and its exception is retired (Amendment 2 there).
- A WSL distro without `systemd=true` gets a live Redwall for the first time. The
  timer needed a user manager to hold it; a hook needs no supervisor of its own.
- A declaration takes effect when redskilled next starts, because Amendment 2 has
  the daemon read machine policy at boot. Converge says so rather than implying
  the desktop is already live.
- red-dev now writes into a file it does not own. Uninstall withdraws the block
  and prunes the chain it created, and removes the file only when red-dev's block
  was the whole of it.
- An operator with their own `plugins.dev.redskilled.hooks` keeps it, and their
  Redwall stops being repainted. That is the correct trade — the alternative is a
  provisioning tool overwriting a policy decision — and it is reported on every
  converge rather than left as a wallpaper that quietly stopped moving.
