import { createReadStream, existsSync } from "node:fs";
import { once } from "node:events";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { spawn } from "node:child_process";
import type { Invocation } from "./cli.ts";
import { log } from "./log.ts";
import { recentTranscripts, transcriptDir } from "./transcript.ts";

export const LOG_APPS = ["red-dev", "red-router", "redskilled", "redcode"] as const;
export type LogApp = typeof LOG_APPS[number];

/** No subprocess, mkdir or install: safe even with older installed app versions. */
export function appLogPath(app: Exclude<LogApp, "red-dev">, opts: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
} = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const path = platform === "win32" ? win32 : posix;
  if (app === "redcode") {
    const base = env.REDCODE_TEST_HOME ?? home;
    const canonical = path.join(base, ".red", "code");
    const legacy = path.join(base, ".red", "redcode");
    const exists = opts.exists ?? existsSync;
    return path.join(!exists(canonical) && exists(legacy) ? legacy : canonical, "data", "log", "redcode.log");
  }
  const file = app === "redskilled" ? "daemon.log" : "red-router.log";
  if (platform === "darwin") return path.join(home, "Library", "Logs", app, file);
  const configured = platform === "win32" ? env.LOCALAPPDATA : env.XDG_STATE_HOME;
  const state = configured && path.isAbsolute(configured) ? configured
    : path.join(home, ...(platform === "win32" ? ["AppData", "Local"] : [".local", "state"]));
  return path.join(state, app, "logs", file);
}

export function logOpener(path: string, platform = process.platform): { argv: string[]; env?: NodeJS.ProcessEnv } {
  if (platform === "win32") return {
    argv: ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Invoke-Item -LiteralPath $env:RED_DEV_OPEN_LOG"],
    env: { ...process.env, RED_DEV_OPEN_LOG: path },
  };
  return { argv: platform === "darwin" ? ["open", path] : ["xdg-open", path] };
}

/** Acknowledge launch, never wait for or kill the user's editor. */
export async function openLog(path: string): Promise<void> {
  if (!existsSync(path)) throw new Error(`log does not exist yet: ${path}`);
  const { argv, env } = logOpener(path);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), { env, detached: true, stdio: "ignore", windowsHide: true });
    let settled = false;
    const done = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.unref();
      if (error) reject(error); else resolve();
    };
    // Catch immediate launcher failures; some platform openers live as long as
    // the editor, so successful submission is the strongest portable claim.
    const timer = setTimeout(() => done(), 500);
    child.once("error", done);
    child.once("exit", code => done(code !== 0 ? new Error(`log opener exited with ${code}`) : undefined));
  });
}

export async function logsCommand(inv: Pick<Invocation, "logsWhich" | "logsApp" | "logsPath" | "logsOpen">): Promise<number> {
  const app = inv.logsApp ?? "red-dev";
  const which = inv.logsWhich;
  if (!(LOG_APPS as readonly string[]).includes(app)) { log.err(`unknown log app '${app}'`); return 1; }
  if (inv.logsPath && inv.logsOpen) { log.err("choose --path or --open"); return 1; }
  if (app !== "red-dev" && which !== undefined) { log.err("run selectors apply only to red-dev"); return 1; }
  if (which === "list" && (inv.logsPath || inv.logsOpen)) { log.err("select a run to use --path or --open"); return 1; }
  let target: string | undefined;
  if (app !== "red-dev") target = appLogPath(app as Exclude<LogApp, "red-dev">);
  else if (which === "crash") target = `${transcriptDir()}/crash.log`;
  else {
    if (which !== undefined && which !== "list" && !/^[1-9]\d*$/.test(which)) {
      log.err(`'${which}' is neither 'list', 'crash' nor a run number`); return 1;
    }
    const all = recentTranscripts();
    if (which === "list") {
      log.ok(`${all.length} transcript(s) in ${transcriptDir()}`);
      for (const [i, file] of all.entries()) log.plain(`  ${i + 1}  ${file}`);
      return 0;
    }
    target = all[which ? Number(which) - 1 : 0];
    if (!target) {
      // Path output must never pretend that a directory is a log file.
      log.err(`no matching transcript — logs live in ${transcriptDir()}`); return 1;
    }
  }
  if (inv.logsPath) { process.stdout.write(`${target}\n`); return 0; }
  try {
    if (inv.logsOpen) await openLog(target);
    else {
      // Reading a run includes its retained chunks, oldest first. Opening/path
      // lookup intentionally points at the current file for the text editor.
      const files = app === "red-dev" ? [4, 3, 2, 1].map(i => `${target}.${i}`).filter(existsSync) : [];
      files.push(target);
      for (const file of files) {
        for await (const chunk of createReadStream(file)) {
          if (!process.stdout.write(chunk)) await once(process.stdout, "drain");
        }
      }
    }
    return 0;
  } catch (error) { log.err(`could not access ${target}: ${String(error)}`); return 1; }
}
