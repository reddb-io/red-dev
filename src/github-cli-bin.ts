import { accessSync, constants, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

export function isMiseShim(path: string): boolean {
  return /(?:^|[\\/])shims[\\/]gh(?:\.(?:exe|cmd|bat))?$/i.test(path);
}

function executable(path: string): boolean {
  try { accessSync(path, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true; }
  catch { return false; }
}

/** Credential discovery must never start mise, including `mise which`. */
export function resolveGithubCli(options: {
  locate?: (name: string) => string | null;
  env?: NodeJS.ProcessEnv;
  has?: (path: string) => boolean;
  list?: (path: string) => string[];
} = {}): string | null {
  const env = options.env ?? process.env;
  const has = options.has ?? executable;
  const locate = options.locate ?? Bun.which;
  const first = locate("gh");
  if (first && !isMiseShim(first)) return first;
  const name = process.platform === "win32" ? "gh.exe" : "gh";
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const path = join(dir, name);
    if (!isMiseShim(path) && has(path)) return path;
  }
  const root = env.MISE_DATA_DIR ?? (process.platform === "win32"
    ? join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "mise")
    : join(env.XDG_DATA_HOME ?? join(env.HOME ?? homedir(), ".local", "share"), "mise"));
  const list = options.list ?? ((path: string) => {
    try { return readdirSync(path); } catch { return []; }
  });
  for (const tool of ["gh", "github-cli"]) {
    const installs = join(root, "installs", tool);
    const versions = ["latest", "current", ...list(installs).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))];
    for (const version of new Set(versions)) {
      const base = join(installs, version);
      const candidates = [join(base, name), join(base, "bin", name),
        ...list(base).filter(entry => /^gh[_-]/.test(entry)).map(entry => join(base, entry, "bin", name))];
      for (const path of candidates) if (has(path)) return path;
    }
  }
  return null;
}
