# Managed configuration lifecycle

When removing or changing a managed default, implement its retirement in the
same change. Removing its generator alone leaves old machines with the policy.

- Retire obsolete files, blocks, drop-ins and automatic hooks during install/update.
- Require ownership evidence, back up exact bytes, and preserve unknown owners.
- Release live controls without killing or restarting user workloads.
- Keep cleanup idempotent and retry failures; a migration ledger is insufficient
  when an older installation can reintroduce a retired definition.
- Verify both fresh installs and upgrades with legacy configuration fixtures.
- Keep diagnostics read-only. New resource restrictions require an explicit
  user choice; do not add automatic RAM, CPU, task or disk admission controls.
