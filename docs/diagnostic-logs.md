# Diagnostic logs

Logs are per-machine state, never synced configuration. Reading a log does not
launch a service, install anything, or create another transcript.

| Application | Default Linux file |
| --- | --- |
| red-dev | `~/.local/state/red-dev/<timestamp>-<command>-p<PID>.log` |
| red-dev crashes | `~/.local/state/red-dev/crash.log` |
| RedRouter | `~/.local/state/red-router/logs/red-router.log` |
| Redskilled daemon | `~/.local/state/redskilled/logs/daemon.log` |
| RedCode | `~/.red/code/data/log/redcode.log` |

For red-dev, RedRouter and Redskilled, absolute `XDG_STATE_HOME` replaces
`~/.local/state` on Linux. Native Windows uses `%LOCALAPPDATA%/<app>/logs`;
red-dev keeps its established XDG-style location on macOS, while RedRouter and
Redskilled use `~/Library/Logs/<app>`. RedCode keeps its existing `.red/code`
location on all platforms, with its legacy `.red/redcode` fallback if migration
has not succeeded. These companion-app paths require their diagnostic-logging
patches; red-dev never starts an older CLI by guessing an unsupported subcommand.

```sh
red-dev logs                   # latest run, existing interface
red-dev logs list
red-dev logs 2 --open
red-dev logs --path
red-dev logs crash --open
red-dev logs --app red-router --path
red-dev logs --app redskilled --open
red-dev logs --app redcode --open
```

`--path` prints only a file path. A missing transcript reports an error; opening
a missing file never creates a misleading empty log. `--open` submits it to the
desktop's default application without waiting for that application to close.
Immediate launcher failures are reported; successful submission is not proof
that a window was displayed. Configure a default text-file application if needed.

The red-dev GNOME menu has **Open red-dev log**. Its agent menu has **Open RedCode
log** (RedCode has no separate native tray in this integration). RedRouter and
Redskilled provide **Open log** in their own tray menus. Use the menu/right-click
action supported by the desktop. Installing updated GNOME extension files can
require signing out and in before the running shell loads the new actions.

## Retention and privacy

New red-dev diagnostic files rotate before exceeding **10 MiB**, retaining the
current file plus `.1` through `.4`. Records larger than 64 KiB are UTF-8 safely
truncated with a marker after common credential forms are redacted. Files are
private (0600 on POSIX); newly created directories are 0700. No global stdout
capture is enabled. Arbitrary payloads may still contain sensitive information:
review files before sharing them.

Transcript families are additionally pruned at run start/end to **20 runs / 50
MiB**. The newest family and live/unknown writers are protected, so this is a
historical budget, not a hard machine-wide disk quota. At the first append,
oversized current/numbered archives are reduced to a bounded tail of complete
records with a retention marker; older content beyond the limit is discarded.
Legacy `crash.previous.log` is preserved and remains visible to `reclaim`.

Reading a red-dev transcript includes its retained chunks oldest-first. Opening
it in an editor points at the current file; older chunks sit beside it as `.1`–`.4`.

`red-dev reclaim` remains an explicit preview/apply workflow for older evidence
and other derived artifacts. It is not a substitute for automatic rotation.

The same 10 MiB / five-file policy is used for companion runtime diagnostic logs.
It does **not** apply to Redskilled Worker/TOONL recovery state, database journals,
opt-in RedRouter request/traffic dumps, or every OS/Electron crash artifact.
Those formats have separate semantics and retention policies; rotating recovery
state as plain text could destroy the ability to resume work.
