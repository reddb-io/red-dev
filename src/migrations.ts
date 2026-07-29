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
