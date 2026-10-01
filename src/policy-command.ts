import type { Platform } from "./platform.ts";
import { miseEntries, convergeMiseConfig } from "./mise-config.ts";
import { AGENTS } from "./agents.ts";
import { TOOLS } from "./manifest.ts";
import { OFFERED_RUNTIMES } from "./runtimes.ts";
import { parsePolicy, toolPolicy, writeToolPolicy } from "./tool-policy.ts";
import { log } from "./log.ts";
import { windowsWsl, runsHere } from "./workstation.ts";
import { withUpdateLock } from "./update-coordinator.ts";

export async function policyCommand(p: Platform, name?: string, mode?: string, version?: string,
  seams: { run?: (argv: string[]) => Promise<number>; relay?: (p: Platform, command: string) => Promise<number> } = {}): Promise<number> {
  // Include external tools whose generated declaration has already been retired.
  const entries: Array<{ alias?: string; spec: string }> = [ ...miseEntries(p), ...AGENTS.filter(a => a.mise).map(a => ({ alias: a.cmd, spec: a.mise! })),
    ...TOOLS.flatMap(t => [t.u24, t.win].filter(pr => pr.kind === "mise").map(pr => pr as { alias?: string; spec: string })),
    ...OFFERED_RUNTIMES.map(r => ({ spec: r.id.split("@")[0]! })) ];
  const tools = new Map(entries.map(e => [e.alias ?? e.spec, e.spec]));
  const key = name && (tools.has(name) ? name : [...tools].find(([, spec]) => spec === name)?.[0]);
  if (name && !key) { log.err(`unknown portable tool '${name}'`); return 1; }
  if (!name && mode) { log.err("choose a tool first"); return 1; }
  const agent = AGENTS.find(a => a.cmd === key);
  const tool = TOOLS.find(t => t.name === key);
  const linux = (agent && !runsHere(agent.placement ?? "both", p)) || (tool && !runsHere(tool.placement ?? "both", p))
    || OFFERED_RUNTIMES.some(r => r.id.split("@")[0] === key);
  const policy = mode ? parsePolicy({ mode, version }) : undefined;
  if (mode !== "fixed" && version) throw new Error("only fixed takes a version");
  if (windowsWsl(p) && linux) {
    const { relayWslCommand } = await import("./wsl-sync.ts");
    return (seams.relay ?? relayWslCommand)(p, `red-dev policy ${key}${mode ? ` ${mode}` : ""}${version ? ` ${version}` : ""}`);
  }
  if (policy) {
    const held = await withUpdateLock(async () => {
      await (await import("./dev-config-migration.ts")).migrateDevConfig(p);
      writeToolPolicy(key!, policy);
      convergeMiseConfig(p);
      if (policy.mode !== "external") {
        const { spawnLogged } = await import("./providers.ts");
        const { miseGithubEnvironment } = await import("./mise-github.ts");
        const argv = ["mise", "use", "-g", "--yes", policy.mode === "fixed" ? "--pin" : "--fuzzy", `${key}@${policy.mode === "fixed" ? policy.version : "latest"}`];
        const code = await (seams.run ?? ((args: string[]) => spawnLogged(args, { env: { ...process.env, ...miseGithubEnvironment() } })))(argv);
        if (code !== 0) return code;
      }
      return 0;
    });
    if (held.busy) { log.warn("another update is running"); return 2; }
    if (held.value !== 0) return held.value;
    if (windowsWsl(p) && (agent?.placement === "both" || tool?.placement === "both")) {
      const { relayWslCommand } = await import("./wsl-sync.ts");
      const code = await (seams.relay ?? relayWslCommand)(p, `red-dev policy ${key} ${mode}${version ? ` ${version}` : ""}`);
      if (code !== 0) return code;
    }
  }
  for (const [tool, spec] of tools) {
    if (key && tool !== key) continue;
    const policy = toolPolicy(tool, spec);
    log.plain(`${tool}: ${policy.mode}${policy.mode === "fixed" ? ` ${policy.version}` : ""}`);
  }
  return 0;
}
