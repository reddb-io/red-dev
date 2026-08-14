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

import { existsSync } from "node:fs";
import { log } from "./log.ts";
import type { Platform } from "./platform.ts";
import { readPreferences, writePreferences } from "./preferences.ts";

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
];

/**
 * Run whatever has not run yet.
 *
 * Failures are reported and recorded as *not* applied, so the next
 * converge tries again. A migration that fails silently and marks
 * itself done is worse than one that never existed.
 */
export async function runPendingMigrations(p: Platform): Promise<number> {
  const prefs = await readPreferences(p);
  const done = new Set(prefs.migrations ?? []);
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

  await writePreferences(p, { migrations: [...done] });
  return ran;
}
