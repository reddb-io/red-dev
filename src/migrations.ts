/**
 * One-off repairs for machines that were already set up.
 *
 * A converge tool fixes what is missing, not what is wrong. When a bug
 * leaves a machine in a state that looks correct — files present,
 * commands on PATH — re-running install changes nothing, because
 * nothing appears to be missing. The font registration bug was exactly
 * that: twelve .ttf files and twelve registry entries, and no
 * application could see the font.
 *
 * omakub solves this with timestamped scripts that run once. Same idea,
 * with the ledger in preferences so a migration cannot run twice and a
 * fresh machine can skip them all — it was never broken.
 *
 * Rules for anything added here:
 *
 *  - Idempotent anyway. The ledger is a promise, not a guarantee; a
 *    preferences file can be deleted.
 *  - Never destructive. A migration runs unattended during install, so
 *    it may repair and must not remove.
 *  - Skip loudly when it does not apply, so `install` on a fresh
 *    machine does not look like it silently did something.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { log } from "./log.ts";
import { providerFor, TOOLS } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, writePreferences } from "./preferences.ts";
import { userBinDir } from "./providers.ts";
import { transcriptDir } from "./transcript.ts";

export interface Migration {
  /** Sortable and unique. The date this was written, not when it runs. */
  id: string;
  /** One line, shown when it runs. */
  describe: string;
  /** False when this machine never had the problem. */
  applies: (p: Platform) => boolean | Promise<boolean>;
  run: (p: Platform) => Promise<void>;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "2026-07-29-font-registration",
    describe: "re-register Nerd Fonts that Windows cannot see",
    /**
     * Machines set up before the registration fix have the .ttf files
     * and registry entries named after the *file* rather than the font
     * family, which resolves to nothing. Everything looks installed and
     * the terminal reports a missing font.
     */
    applies: async (p) => {
      if (p.os !== "windows" && p.env !== "wsl") return false;
      const shell =
        p.os === "windows"
          ? "powershell.exe"
          : (Bun.which("powershell.exe") ??
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
      const proc = Bun.spawn(
        [
          shell,
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Drawing; " +
            "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
            "Where-Object { $_.Name -like '*Nerd Font Mono' } | Measure-Object | " +
            "Select-Object -ExpandProperty Count",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      // Zero visible Nerd Fonts is the symptom. A machine that never
      // installed one is also zero, but re-registering is harmless
      // there: the installer skips when no files exist.
      return out === "0";
    },
    run: async (p) => {
      const { installNerdFont } = await import("./wsl.ts");
      void p;
      await installNerdFont("firacode");
    },
  },
  {
    id: "2026-08-01-font-machine-wide",
    describe: "install the Nerd Font machine-wide where per-user is ignored",
    /**
     * The registration repair above assumed a correct HKCU entry is
     * enough. On some machines it is not — an Entra-joined Windows 11 was
     * seen ignoring per-user font registrations across a full sign-out,
     * files and registry both correct and no application able to see the
     * family. The previous migration ran, reported success, and marked
     * itself done, so the ledger has to be asked again under a new id.
     *
     * Same symptom as before, so the same question: nothing visible.
     */
    applies: async (p) => {
      if (p.os !== "windows" && p.env !== "wsl") return false;
      const shell =
        p.os === "windows"
          ? "powershell.exe"
          : (Bun.which("powershell.exe") ??
            "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe");
      const proc = Bun.spawn(
        [
          shell,
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Drawing; " +
            "(New-Object System.Drawing.Text.InstalledFontCollection).Families | " +
            "Where-Object { $_.Name -like '*Nerd Font Mono' } | Measure-Object | " +
            "Select-Object -ExpandProperty Count",
        ],
        { stdout: "pipe", stderr: "ignore" },
      );
      const out = (await new Response(proc.stdout).text()).trim();
      await proc.exited;
      return out === "0";
    },
    /**
     * The font chosen at setup, not a hardcoded one: re-installing
     * FiraCode on a machine configured for JetBrains Mono would leave
     * the terminal pointing at a family that is still missing.
     */
    run: async (p) => {
      const { installNerdFont } = await import("./wsl.ts");
      const prefs = await readPreferences(p);
      await installNerdFont(prefs.font ?? "firacode");
    },
  },
  {
    id: "2026-08-06-share-root-namespace",
    describe: "move the shared root out of .reddev and into .red\\dev",
    /**
     * The share was a flat `.reddev` in the profile, which put it outside
     * the `.red` namespace everything else in the toolchain writes into.
     * Machines set up before the rename have a working root at the old
     * spelling, so nothing looks broken and converge has no reason to
     * touch it — which is exactly the shape a migration exists for.
     */
    applies: async (p) => {
      if (p.env !== "wsl" && p.env !== "windows") return false;
      const { namespaceMove, recordedShareRoot, windowsHome, localPath } = await import(
        "./shared-root.ts"
      );
      const move = namespaceMove(recordedShareRoot(), await windowsHome(p));
      if (!move) return false;
      // A recorded root whose directory is gone is a different problem,
      // and copying nothing over it would not fix that one either.
      return existsSync(localPath(move.from, p.env));
    },
    /**
     * Copied, not moved, and the old tree is left where it is.
     *
     * This runs unattended during install, across a filesystem boundary,
     * over the directory holding every config the user has. A copy that
     * half-finishes leaves both trees intact; a move that half-finishes
     * leaves neither. The old one costs a few hundred kilobytes and is
     * removed by hand, once, by someone who can see both.
     */
    run: async (p) => {
      const { namespaceMove, recordedShareRoot, windowsHome, localPath, ensureSharedRoot } =
        await import("./shared-root.ts");
      const { recordShellEnv } = await import("./firstrun.ts");

      const move = namespaceMove(recordedShareRoot(), await windowsHome(p));
      if (!move) return;

      const from = localPath(move.from, p.env);
      const to = localPath(move.to, p.env);

      if (existsSync(to)) {
        log.skip(`${move.to} already exists — leaving it as it is`);
      } else {
        const { cpSync, mkdirSync } = await import("node:fs");
        mkdirSync(to, { recursive: true });
        cpSync(from, to, { recursive: true });
        log.ok(`copied the share to ${move.to}`);
      }

      // Recorded before ensureSharedRoot, which reads it back.
      await recordShellEnv({ RED_SHARE_WIN: move.to });
      process.env["RED_SHARE_WIN"] = move.to;
      await ensureSharedRoot(p);

      log.plain(`       ${move.from} is left in place and is no longer read —`);
      log.plain(`       delete it yourself once you have looked inside both`);
    },
  },
  {
    id: "2026-08-06-theme-slugs-retired",
    describe: "point a recorded theme at the RedDB palette that replaced it",
    /**
     * Ten omakub palettes became six RedDB themes, and every machine
     * red-dev has ever configured has one of the old slugs written into
     * its preferences.
     *
     * `resolveThemeSlug` already heals this on read, which is what makes
     * a converge correct without this migration. What the ledger adds is
     * the *record*: the file stops saying `tokyo-night`, so anyone
     * reading it — a person, a support question, a future migration —
     * sees what the machine actually is rather than what it used to be.
     */
    applies: async (p) => {
      const { isThemeSlug } = await import("./themes.ts");
      const recorded = (await readPreferences(p)).theme;
      return recorded !== undefined && !isThemeSlug(recorded);
    },
    run: async (p) => {
      const { resolveThemeSlug } = await import("./themes.ts");
      const prefs = await readPreferences(p);
      const next = resolveThemeSlug(prefs.theme);
      log.plain(`       ${prefs.theme} is retired; this machine is now ${next}`);
      await writePreferences(p, { theme: next });
    },
  },
  {
    id: "2026-08-06-theme-vim-released",
    describe: "stop pinning Neovim's colorscheme",
    /**
     * red-dev used to write ~/.config/nvim/lua/plugins/red-dev-theme.lua,
     * which does not merely record a colour — it declares a plugin and
     * pins `colorscheme`. It no longer themes Neovim, so left alone that
     * file keeps every existing machine on tokyonight forever while
     * red-dev claims to have stopped.
     *
     * Emptied to `return {}` rather than deleted. The ledger's rule is
     * "may repair and must not remove", and the case for an exception —
     * the file is provably ours, byte for byte — is exactly the argument
     * that would be made for the next exception too. LazyVim falls back
     * to its own default either way; the cost is an inert file, and an
     * inert file explaining itself is cheap.
     */
    applies: (p) => {
      void p;
      const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
      return existsSync(`${home}/.config/nvim/lua/plugins/red-dev-theme.lua`);
    },
    run: async (p) => {
      void p;
      const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
      const path = `${home}/.config/nvim/lua/plugins/red-dev-theme.lua`;

      // Only if it is ours. Someone may have replaced the contents with
      // their own colorscheme and kept the filename, and emptying that
      // would be taking away a choice rather than releasing one.
      const current = await Bun.file(path).text();
      if (!current.includes("Generated by red-dev")) {
        log.skip("red-dev-theme.lua is not ours any more — left alone");
        return;
      }

      await Bun.write(
        path,
        `-- Generated by red-dev, and intentionally empty.
--
-- red-dev no longer themes Neovim: everything inside the terminal takes
-- one fixed palette instead, so pinning a colorscheme here would be
-- overriding it. LazyVim falls back to its own default.
--
-- Nothing rewrites this file. Delete it, or put your own colorscheme in
-- it; either is fine.
return {}
`,
      );
      log.plain("       Neovim is yours again — LazyVim picks its own colorscheme");
    },
  },
  {
    id: "2026-08-14-opencode-to-redcode",
    describe: "move the selected terminal agent from OpenCode to RedCode",
    applies: async (p) => {
      if ((await readPreferences(p)).agents?.includes("opencode") !== true) return false;
      const { availableAgents } = await import("./agents.ts");
      return availableAgents(p).some((agent) => agent.key === "redcode");
    },
    run: async (p) => {
      const { availableAgents, currentAgentKeys, installAgent, isAgentReady } = await import(
        "./agents.ts"
      );
      const prefs = await readPreferences(p);
      const redcode = availableAgents(p).find((agent) => agent.key === "redcode");
      if (!redcode) throw new Error(`RedCode has no release for ${p.os}/${p.arch}`);
      if (!(await isAgentReady(redcode))) await installAgent(redcode, p);
      const agents = currentAgentKeys(prefs.agents ?? []);
      await writePreferences(p, { agents });
      log.plain("       installed and selected RedCode; the existing OpenCode binary and config were left untouched");
    },
  },
  {
    id: "2026-08-15-release-binaries-to-mise",
    describe: "hand the tools that moved to mise over from ~/.local/bin",
    /**
     * Without this the move to mise is a no-op, silently.
     *
     * Every one of these tools was installed by the `gh` provider, which
     * writes a plain binary into ~/.local/bin. A converge asks
     * `installState` whether the tool is there, `installState` asks PATH,
     * PATH answers with that binary, and the mise provider never runs —
     * so the machine keeps the version it happened to fetch on install
     * day, which is the exact problem the move was made to fix. Measured
     * on the maintainer's host: tq 0.26.2 on PATH, 0.28.2 released.
     *
     * And if mise did install alongside, the result is worse rather than
     * better: two copies, PATH order decides the winner, and `mise
     * upgrade` reports success while updating the one nobody executes.
     * That is the same argument mise-config.ts uses to keep red-dev
     * itself out of the fragment; it applies here and had to be paid.
     */
    applies: (p) => staleReleaseBinaries(p).length > 0,
    run: async (p) => {
      const stale = staleReleaseBinaries(p);

      // Install before removing, not after. A migration runs before the
      // converge, so removing first would be fine on a good day and
      // would leave a developer with no `red` and no `tq` on a day when
      // GitHub is unreachable. Nothing is taken away until mise can
      // answer for it.
      const { miseInstallSuite } = await import("./providers.ts");
      await miseInstallSuite(p);
      const mise = Bun.which("mise");
      if (!mise) throw new Error("mise is not installed yet — nothing to hand over to");

      for (const { name, path } of stale) {
        // Proof, per tool, that the replacement exists before the
        // original goes. `mise which` resolves through the fragment, so
        // a tool whose install quietly failed keeps its old binary and
        // is reported rather than deleted.
        //
        // Asked by command name rather than by spec: mise answers to
        // the binary, and `mise which github:reddb-io/zellij` is an
        // error while `mise which zellij` is a path. Getting that
        // backwards would have left every unaliased tool's stale copy
        // in place while reporting that it had checked.
        const which = Bun.spawnSync([mise, "which", name], { stdout: "pipe", stderr: "ignore" });
        if (which.exitCode !== 0) {
          log.warn(`       ${name}: mise has no copy yet, leaving ${path} in place`);
          continue;
        }
        // Never delete the binary this process is running from. On
        // Linux it would appear to work — the inode outlives the unlink
        // — and on Windows it fails outright with the file locked. Both
        // are the wrong thing to attempt while red-dev is updating
        // red-dev. The shim already wins on PATH, so the next run
        // executes the mise copy and this one sweeps the leftover.
        if (samePath(path, process.execPath)) {
          log.plain(`       ${name}: mise owns it now; ${path} goes on the next run`);
          continue;
        }
        rmSync(path, { force: true });
        log.plain(`       ${name}: removed ${path}; mise now owns it`);
      }
    },
  },
  {
    id: "2026-08-16-red-skills-legacy-retention",
    describe: "adopt the RedSkills state the old install mode left behind",
    /**
     * The second half of handing RedSkills to mise, and the half mise
     * cannot do.
     *
     * `mise prune` now runs at the end of every update, and it collects
     * the versions it installed. What it will never look at is the
     * shape the curled installer produced — extracted trees under
     * ~/.red/skills/versions, the tarballs they were unpacked from, the
     * Git-sourced marketplaces, the generated OpenCode/RedCode and pi
     * surfaces, and the copy each agent host kept of every plugin
     * version it has ever carried. Measured on one developer machine:
     * about 1.16 GB, none of it collected by anything, because the only
     * thing that could have was the same install script.
     *
     * This used to remove all of it here, ungated, in the same pass
     * that planned it — which on a machine where the package set had
     * not landed took the only RedSkills there was. ADR 0010 draws the
     * line the other way: adopt and back up first, and remove obsolete
     * ownership **only after the new source and every managed surface
     * verify**. So the removal is no longer this migration's; the
     * gated adoption in src/red-skills-adopt.ts owns it, and the
     * migration is what asks it to run.
     *
     * Still safe under the rule at the top of this file for the reason
     * it always was — everything it can take is derived state, and what
     * anything resolves through is protected by name — and now safe for
     * a second reason: on a machine that has not converged, the gate
     * refuses and nothing is removed at all.
     */
    applies: async (p) => {
      void p;
      const { inventoryLegacyWorkstation } = await import("./red-skills-adopt.ts");
      return (await inventoryLegacyWorkstation()).items.length > 0;
    },
    run: async (p) => {
      void p;
      const { adoptLegacyWorkstation, announceAdoption } = await import("./red-skills-adopt.ts");
      const { formatBytes } = await import("./reclaim.ts");

      const adoption = await adoptLegacyWorkstation();
      announceAdoption(adoption);
      if (adoption.removed.length === 0) return;

      // Named one by one, and then totalled. A deletion that reports
      // only a number is one nobody can check afterwards, and this is
      // the single migration in the ledger that takes a gigabyte.
      log.plain(
        `       ${adoption.removed.length} left over, ${formatBytes(adoption.bytes)} back`,
      );
      log.plain(`       backed up to ${adoption.backup}`);
    },
  },
  {
    id: "2026-08-19-red-skills-under-red",
    describe: "move RedSkills from ~/.red-skills into ~/.red/skills",
    /**
     * The package set used to live beside the `.red` namespace instead
     * of inside it, while everything else red-dev keeps for a person —
     * config.yaml, state, the redskilled daemon's files — was already
     * under ~/.red. One directory to look in, one to remove: the root is
     * now ~/.red/skills (src/red-skills-root.ts), and a machine
     * provisioned under the old name is brought across here.
     *
     * This moves rather than copies — see relocateLegacyRedSkillsRoot
     * for why a rename is the safer of the two for a tree this size —
     * and removes exactly one file, the reconcile stamp, because it
     * records a fact the move made false. Nothing is left at the old
     * name — not even a symlink; one RedSkills directory per home is the
     * point. The hosts are re-registered by the converge that runs right
     * after the ledger, which compares each record against the new path
     * and rewrites the ones naming the old one.
     *
     * The adoption above runs first and inventories under both names
     * (red-skills-adopt.ts, standaloneRoots), so a Spec #185 machine
     * that had done neither is adopted where its state still is; what
     * the gate refuses to remove yet is carried across and adopted from
     * the new root on a later run.
     */
    applies: async (p) => {
      void p;
      const { lstatSync } = await import("node:fs");
      const { homedir } = await import("node:os");
      const { legacyRedSkillsRoot } = await import("./red-skills-root.ts");
      try {
        const stat = lstatSync(legacyRedSkillsRoot(homedir()));
        return stat.isDirectory() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    },
    run: async (p) => {
      void p;
      const { homedir } = await import("node:os");
      const { legacyRedSkillsRoot, redSkillsRoot, relocateLegacyRedSkillsRoot } = await import(
        "./red-skills-root.ts"
      );
      const home = homedir();
      const result = relocateLegacyRedSkillsRoot(home);
      switch (result.outcome) {
        case "nothing":
          log.skip(`${legacyRedSkillsRoot(home)} holds no tree to move`);
          return;
        case "kept":
          log.skip(`${redSkillsRoot(home)} already exists — ${legacyRedSkillsRoot(home)} is left as it is`);
          log.plain(`       nothing reads the old root any more; remove it yourself once you have looked inside`);
          return;
        case "moved":
          log.plain(`       ${legacyRedSkillsRoot(home)} -> ${redSkillsRoot(home)}`);
          for (const link of result.relinked) log.plain(`       re-pointed ${link}`);
          for (const file of result.cleared) log.plain(`       cleared ${file}; the hosts are re-registered at the new path below`);
          return;
      }
    },
  },
];

/**
 * The ~/.local/bin binaries left behind by the release provider.
 *
 * Only ~/.local/bin, and only for tools this platform now gets from
 * mise. A copy anywhere else was put there by something that is not
 * red-dev — carapace's .deb under /usr/bin is the real example — and
 * removing another package manager's file is not a repair. Those are
 * shadowed instead: config/bash/path.sh puts mise's shims ahead of both.
 */
/** Two paths naming one file, on a platform where case may not matter. */
function samePath(a: string, b: string): boolean {
  const norm = (v: string) => {
    const slashed = v.replace(/\\/g, "/");
    return process.platform === "win32" ? slashed.toLowerCase() : slashed;
  };
  return norm(a) === norm(b);
}

export function staleReleaseBinaries(p: Platform): { name: string; path: string }[] {
  let bin: string;
  try {
    bin = userBinDir();
  } catch {
    return [];
  }
  const out: { name: string; path: string }[] = [];
  for (const tool of TOOLS) {
    const pr = providerFor(tool, p);
    if (pr.kind !== "mise") continue;
    for (const cmd of tool.cmd ?? [tool.name]) {
      for (const candidate of [`${bin}/${cmd}`, `${bin}/${cmd}.exe`]) {
        if (existsSync(candidate)) out.push({ name: cmd, path: candidate });
      }
    }
  }
  return out;
}

/**
 * `<state>/migrations.json` — what this side of the machine has run.
 *
 * The ledger used to live in the preferences file, and on a WSL machine
 * that file is the *host's*: `configDir` sends the distro to the
 * Windows AppData so the terminal, the theme and the chosen runtimes
 * are one answer across the boundary (src/alacritty.ts). Those belong
 * shared. A repair does not. `2026-08-19-red-skills-under-red` ran
 * inside the distro, moved the tree there, and recorded itself — and
 * the Windows side, whose own `~/.red-skills` was still sitting beside
 * the new root, then read that record and skipped the repair for good.
 * Two filesystems, one list, and whichever side converged first spoke
 * for both.
 *
 * The transcript directory is already per-side — it is where each
 * side's own run logs land — so the ledger goes beside the evidence of
 * the runs that wrote it.
 *
 * Nothing is carried over from the old shared list. Seeding from it
 * would reproduce exactly the bug above on every machine that has one:
 * the entries there may have been written by the other side. What
 * protects a machine from a second run is `applies()`, which asks the
 * disk rather than the ledger — the ledger's job is to stop re-asking,
 * not to be the only thing standing between a machine and a repair it
 * has already had.
 */
export function migrationLedgerPath(env?: Record<string, string | undefined>): string {
  return `${transcriptDir(env)}/migrations.json`;
}

/** What this side has run, or an empty set on a machine that has run nothing. */
export function readMigrationLedger(path = migrationLedgerPath()): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { applied?: unknown };
    if (!Array.isArray(parsed.applied)) return new Set();
    return new Set(parsed.applied.filter((id): id is string => typeof id === "string"));
  } catch {
    // Absent, or written by something that is not this. Either way the
    // migrations below decide for themselves whether they apply.
    return new Set();
  }
}

/** Record what this side has run. A ledger that cannot be written is not fatal. */
export function writeMigrationLedger(applied: Iterable<string>, path = migrationLedgerPath()): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ schema: 1, applied: [...applied].sort() }, null, 2)}\n`);
  } catch {
    // The worst case is re-checking every `applies()` on the next
    // converge, which is what this file exists to save rather than
    // something it is needed for.
  }
}

/**
 * Run whatever has not run yet.
 *
 * Failures are reported and recorded as *not* applied, so the next
 * converge tries again. A migration that fails silently and marks
 * itself done is worse than one that never existed.
 */
export async function runPendingMigrations(p: Platform): Promise<number> {
  const ledger = migrationLedgerPath();
  const done = readMigrationLedger(ledger);
  const pending = MIGRATIONS.filter((m) => !done.has(m.id));

  if (pending.length === 0) return 0;

  let ran = 0;
  for (const m of pending) {
    let applies: boolean;
    try {
      applies = await m.applies(p);
    } catch {
      // A check that cannot run is not evidence the machine is broken.
      continue;
    }

    if (!applies) {
      // Record it anyway: this machine never had the problem, and
      // re-checking on every converge costs a subprocess for nothing.
      done.add(m.id);
      continue;
    }

    log.step(`repair: ${m.describe}`);
    try {
      await m.run(p);
      done.add(m.id);
      ran++;
      log.ok(m.id);
    } catch (err) {
      log.warn(`${m.id} failed, will retry next time: ${(err as Error).message}`);
    }
  }

  writeMigrationLedger(done, ledger);
  return ran;
}
