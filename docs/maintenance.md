# Maintenance and recovery

## Timeouts behind a corporate VPN

Run `red-dev network`. Each probe has a deadline and the report distinguishes:

- Local gh credential lookup, without a mise shim or a nested mise process.
- Local mise credential lookup, reporting the credential source only.
- OS HTTP access to the GitHub API, the release redirect and the npm registry.
- A remote-version request through mise with its metadata cache bypassed.

If OS HTTP works but local mise credentials time out, repair the managed helper:

```sh
red-dev doctor --repair mise-auth
red-dev doctor --repair mise-auth --apply
red-dev network
```

The first command previews the changes. The second rewrites the managed helper
and mise fragment, migrating obsolete gh overrides with a backup. It installs
and upgrades no packages and never stores the token in a configuration file.

If credentials work but HTTP fails, use the reported host and error to inspect
VPN routing, DNS, corporate CA trust and proxy authentication. Authentication
does not fix a transport timeout. If curl works and only mise's remote request
fails, investigate mise's HTTP client/configuration; do not assume an anonymous
GitHub quota. This comparison narrows the cause and does not prove a specific
VPN fault.

The report records whether proxy environment variables are configured, omitting
their addresses and values. `red-dev network --json` emits machine-readable
output without credential command output. These probes are network requests;
they do not change proxy settings or turn certificate verification off.

## Targeted repairs

`red-dev doctor --repair <name>` previews one operation. Add `--apply` to execute:

| Name | Changes |
| --- | --- |
| `mise-auth` | Managed gh helper, mise fragment and obsolete gh credential overrides |
| `workloads` | Retire obsolete resource wrappers, quotas, Cargo defaults, disk freezer and marked WSL resource rows |
| `desktop` | Managed GNOME menu and shortcuts; may still require a fresh login |

Workload repair backs up recognised red-dev files and blocks, disables the old
disk guardian, thaws controlled groups, and releases live memory/CPU/I/O/task
controls. It removes generated policies instead of keeping permanent
`MemoryMax=infinity` replacements. Native service resource settings are
preserved when retiring a red-dev drop-in. It starts no workloads and restarts
none. Already-loaded shell functions disappear when the shell is reopened.

WSL settings without ownership markers are preserved: older releases did not
record provenance for every edit, so an unmarked budget cannot safely be
attributed to red-dev. Marked rows are retired; changes take effect at the next
user-initiated WSL restart. Red-dev does not run `wsl --shutdown`.

Retirement runs during installation/update even if a previous migration was
recorded as complete. Generated mise hooks also run this cleanup after Linux
red-dev upgrades; older desktop-only hooks are recognised on the upgraded
binary. Cleanup failures remain visible and retryable. Backups live under
`~/.local/state/red-dev/retired-resource-controls` with mode 0600.

## Retiring managed defaults in future releases

A release that withdraws a default must stop generating it and remove its owned
installed definitions. Use the retirement registry to name each file/block and
its ownership evidence. Preserve unknown owners and retain exact private backups.
Test a clean machine, an upgrade with historical files, live quota release,
partial failures and repeated cleanup. Doctor must report obsolete leftovers;
it must not recommend reinstalling withdrawn controls. Resource policy is a
user or project decision; new automatic restrictions are not part of provisioning.

## Share a doctor report

```sh
red-dev doctor --json
red-dev doctor --export report.json
```

JSON reports retain the diagnostic sections and verdict. Known credential forms
and home paths are redacted before serialization. Exported files are created
privately (0600 on Linux); the command refuses to overwrite existing files or
symlinks. Review a report before sharing it if local project/tool names are
sensitive. No raw environment dump or process argument inventory is exported.

Where the journal is readable, doctor reports historical OOM victim PIDs,
commands and groups present in journal evidence. It reports missing evidence
explicitly and does not associate reused current PIDs with historical victims.

## Update outcomes

Updates show a result for each stage. A newer installed red-dev performs the
convergence through its own executable, without repeating earlier update stages.

| Exit | Meaning |
| --- | --- |
| `0` | All requested stages completed |
| `1` | A required stage/convergence failed |
| `2` | Convergence still needs rights or another deferred action |
| `3` | Convergence succeeded, but an update/retention stage failed |

Pruning does not run after a failed converge. Nonfatal failures remain visible
in the summary instead of being reported as a complete update.

Direct red-dev HTTP transfers retry transient 502/503/504 or rate-limited
responses at most twice within the original total request deadline. They respect
`Retry-After` and quota-reset headers; an hour-long reset is reported, without
holding the command open for an hour. Invalid credentials and ordinary 403
access refusals are not repeatedly retried. Mise owns retries for its own HTTP
requests; red-dev does not silently change its network settings.
