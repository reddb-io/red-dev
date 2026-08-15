# 0004 — Reclaim is asked for, never scheduled

- Status: accepted
- Date: 2026-08-10

## Context

A machine that runs red-dev accumulates cost it never gives back. The WSL virtual
disk grows and does not shrink: measured on the maintainer's host, `ext4.vhdx`
occupied 184.9 GB while the filesystem inside it used 37 GB — roughly 148 GB held
by nothing. Build caches keep artefacts no build will read again. Journals keep
lines past their usefulness. None of this is drift against the manifest, so a
converge sees a healthy machine and moves on.

The obvious answer is a scheduled task. Every operating system red-dev targets
offers one, the work is periodic by nature, and an operator who has to remember
to reclaim disk will not remember until the disk is full — which is exactly the
state this decision was taken in, with 18 GB free of 894 GB.

That answer was rejected. What follows is why, because the next reader will
propose it again.

## Decision

**Reclaim runs when an operator asks for it, and at no other time.** It is not a
converge step, not a scheduled task, and not a systemd timer. red-dev schedules
nothing today — no `schtasks`, no timer, no cron — and this decision keeps that
true.

Three consequences follow, and each is part of the decision rather than an
implementation detail:

**A Reclaim refuses while Workers are alive.** Compacting the virtual disk means
shutting the virtual machine down, and AFK Workers are systemd units inside it.
An interrupted Worker loses its attempt. Waiting costs minutes; interrupting
costs the work.

**The compaction is a wizard, not a command.** `wsl --shutdown` invoked from
inside WSL kills the process that invoked it, so the command cannot survive to
report what it did. Rather than invent an orchestration that outlives its own
death, red-dev generates a script the operator runs from the Windows side.

**Reclaim never removes anything a person authored.** Not code, not branches, not
uncommitted work, and not a value an operator wrote into their own configuration.
The test is what losing it costs: if only time, it is Reclaim's to take; if work,
it is not.

**Amendment (2026-08-15):** the premise "red-dev schedules nothing today" no
longer holds — since 2026-08-12 the Redwall repaint runs on a systemd user
timer / Task Scheduler task (`src/redwall-schedule.ts`). That is a deliberate
exception, not a reopening: a Redwall tick is derived and idempotent, touches
nothing a person authored, and costs nothing when it surprises someone. The
prohibition here is scoped to Reclaim and Rescue (ADR 0005) — acts that delete
or interrupt — and stays in force for them.

## Consequences

An operator with a full disk and no memory of this feature stays stuck. That is
the real cost, and it is accepted: `doctor` reporting reclaimable space is the
mitigation, and it does not automate anything.

The decision also constrains what may be added later. A future item that wants to
reclaim on a timer is not a small extension — it reopens this ADR, because the
argument here is not "scheduling is hard" but "these acts cost more when they
surprise someone than when they wait".

## Alternatives considered

**A scheduled task** — the conventional answer, rejected above. It would also make
red-dev a project that installs background jobs, which nothing in it does today.

**A converge step** — rejected because a converge is something people run to make
a machine correct, and they do not expect it to shut the machine down or delete
caches. It would also make the converge's runtime depend on how long a virtual
disk takes to compact.

**Report only, act never** — `doctor` names the reclaimable space and stops. This
is retained as the discovery half, but on its own it leaves the operator to
assemble the commands, which is where a half-remembered `diskpart` invocation
against the wrong file becomes possible.
