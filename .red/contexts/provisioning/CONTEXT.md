# Context: provisioning

Convergence engine — manifest, providers, plan/apply, and the proof discipline.

## E2E lane

A clean machine (VM) for one target platform that walks the full journey — install → second convergence with zero drift → theme/font switch → N-1 update → rollback → uninstall. Incremental definition of done: each phase only closes with lanes covering what it shipped; no item is ever declared ready by mere file existence.
