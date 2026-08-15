# Context: provisioning

Convergence engine — manifest, providers, plan/apply, and the proof discipline.

## Reclaim

Giving back host resource that has already been spent — disk a virtual disk grew into and never released, build caches nothing reads any more, logs kept past their usefulness. Reclaim is the counterpart to convergence: convergence makes a machine match the manifest, Reclaim makes it give back what matching it cost.

It is never a side effect of a converge and never scheduled. An operator asks for it, because the acts it performs — shutting down the virtual machine, deleting caches — cost more when they surprise someone than when they wait. For the same reason a Reclaim refuses while Workers are alive rather than interrupting them.

Reclaim never removes anything a person authored: not code, not branches, not uncommitted work, and not a value an operator wrote into their own configuration. What it touches is derived, and derived is the whole test — if losing it costs only time, it is Reclaim's to take; if losing it costs work, it is not.

## Host health

The current resource and lifecycle posture of the machine: process and task counts, cgroup capacity, memory, disk, recent OOM/stop-timeout evidence, Worker isolation, and generated-artifact budgets. Host health is observed by `doctor`; it is not drift against the provisioning manifest and an unknown observation is never treated as healthy.

## Rescue

Evidence-driven online recovery of process groups whose owner has disappeared. Rescue is distinct from Reclaim: it may run while Workers are alive, but it protects every registered Worker, active unit, terminal, daemon descendant, and the current command ancestry. Preview is the default. Apply requires multiple independent orphan signals, a private forensic snapshot, PID start-time revalidation, group-wide TERM/KILL, and a verification snapshot. There is deliberately no force mode.

## Catalogue

The list of items a person ticks rather than receives — `optional` tools, web apps, services — offered by `red-dev apps` and the interview. Ticking installs; **unticking an installed item removes it**, after naming what goes, so the place where a person looks at the list is also where they take something out. Whole-product removal stays `red-dev uninstall`; the manifest's `core`/`desktop`/`wsl` scopes are not catalogue and are never unticked (decision of 2026-08-15).

_Avoid_: optional list, extras, pre-installs (Omarchy's word for the same tier)

## E2E lane

A clean machine (VM) for one target platform that walks the full journey — install → second convergence with zero drift → theme/font switch → N-1 update → rollback → uninstall. Incremental definition of done: each phase only closes with lanes covering what it shipped; no item is ever declared ready by mere file existence.
