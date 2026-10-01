import type { Platform } from "./platform.ts";
import { AGENTS, agentRunsHere, agentInstallMethod, isAgentInstalled, installAgent, type AgentSpec } from "./agents.ts";
import { toolPolicy } from "./tool-policy.ts";
import { profileToolEnabled } from "./machine-profile.ts";
import { log } from "./log.ts";

/** The selected hosts only; catalog membership never selects a new agent. */
export async function profileAgentPlan(p: Platform, ready: (a: AgentSpec) => boolean | Promise<boolean> = isAgentInstalled) {
  if (!profileToolEnabled(p, "selected-agents")) return [];
  const entries = [];
  for (const agent of AGENTS.filter(a => p.profile?.agents?.includes(a.key))) {
    const policy = agent.mise ? toolPolicy(agent.cmd, agent.mise) : undefined;
    const method = agentInstallMethod(agent, p);
    const action = !agentRunsHere(agent, p) || !method ? "skip" : policy?.mode === "external" ? "unmanage" : await ready(agent) ? "keep" : "install";
    const target = !agentRunsHere(agent, p) ? "Ubuntu/WSL" : p.os === "windows" ? "Windows" : p.env === "wsl" ? "Ubuntu/WSL" : "Ubuntu";
    entries.push({ agent, action, policy, target, method });
  }
  return entries;
}
export async function convergeProfileAgents(p: Platform): Promise<void> {
  let failures = 0;
  for (const step of await profileAgentPlan(p)) {
    if (step.action !== "install") { log.skip(`${step.agent.label}: ${step.action}`); continue; }
    try { await installAgent(step.agent, p); }
    catch (err) { failures++; log.err(`${step.agent.label}: ${(err as Error).message}`); }
  }
  if (failures) throw new Error(`${failures} selected agent(s) failed to install`);
}
