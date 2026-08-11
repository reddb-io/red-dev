# 0005 — Host Rescue is evidence-driven and separate from Reclaim

- Status: accepted
- Date: 2026-08-11

## Context

A WSL environment accumulated roughly 21,000 processes, exhausted process creation and produced 7.89 GB of crash dumps. Recovery had to preserve live Claude, Codex, terminal, monitor and redskilled sessions. Two repeatable survivors were found: a statusline waiting forever for stdin EOF and a test dispatcher running from a deleted worktree. Reaping by process name, age, or parent PID alone would have killed legitimate work.

ADR 0004 already defines Reclaim as operator-requested cleanup of derived disk artefacts and requires it to refuse while Workers are alive. Online process recovery has a different safety boundary and cannot share that rule.

## Decision

`doctor` observes Host health without mutation. `rescue` previews online process recovery and `reclaim` previews derived-file retention; neither is scheduled or part of converge.

Rescue may operate beside live Workers, but only a process group classified `proven-orphan` is actionable. Classification requires current-user ownership, a minimum age, no protected terminal/command/daemon/Worker/unit relationship, and at least two independent abandonment signals. Apply writes a private before snapshot, revalidates PID start times and protections, signals the complete group or Worker cgroup, and writes an after snapshot. Suspect and unknown groups are report-only. There is no force mode.

Reclaim continues to obey ADR 0004: active or unknown Worker state refuses apply. It removes only derived files selected by documented TTL/count/byte budgets, after inode/size/mtime revalidation. Windows CrashDumps require an extra explicit flag. VHDX compaction remains a separate Windows-side wizard.

## Consequences

- RedSkills remains the authority for Worker lifecycle and logs; red-dev protects the host when that authority is absent or interrupted.
- An ambiguous process survives and is reported. Recovery prefers a false negative over destroying live work.
- Incident snapshots may contain paths and process topology, so they are sanitized, omit environments and are mode `0600` on POSIX.
- Online Rescue is implemented on Linux/WSL first. Native Windows receives disk and dump diagnostics but no process termination in this phase.
