/**
 * Which RedSkills plugins this machine carries, derived from the manifest.
 *
 * `dev`, `memory` and `brain` used to be a literal, written out twice —
 * once in the Claude marketplace repair and once in the Codex one. Two
 * costs came with that. A machine that only ever uses `dev` still
 * installed all three, because an unconditional list is not a choice
 * anybody made. And adding a fourth plugin meant editing two places that
 * were free to disagree: the pair was correct the day it was written and
 * had no way of staying that way.
 *
 * So a plugin becomes a manifest entry like every other optional item.
 * The manifest is already where "what this machine has" is declared, and
 * an entry inherits `mise upgrade` and `mise prune` for free — which is
 * the whole reason to spend the entry rather than invent a plugin list
 * of our own. Opting one out is deleting its row: no entry, no mise
 * install, and nothing for the repairs to reinstall.
 *
 * ## Derived from the projection, not from the rows
 *
 * The set comes out of `miseEntries`, the same pure function that
 * renders the fragment, rather than out of TOOLS directly. That is what
 * makes "the fragment and the loops agree" true by construction instead
 * of by inspection: there is one filter, over one list, and a plugin a
 * platform declines through a `skip` column disappears from both at once.
 *
 * ## The short name is the package name
 *
 * A plugin is published as `@reddb-io/red-skills-<name>`, and the hosts
 * install it as `<name>@red-skills`. The two spellings are one fact, so
 * the short name is read off the spec rather than declared a second time
 * beside it — a `name: "dev"` field on the row would be one more pair
 * that can disagree, which is the thing this file exists to remove.
 *
 * The core (`npm:@reddb-io/red-skills`, no suffix) is deliberately not
 * matched: it carries the marketplace manifests the plugins are listed
 * in, so counting it as a plugin would install it twice and offer the
 * payload itself as something to opt out of.
 */

import { TOOLS, type Tool } from "./manifest.ts";
import { miseEntries, type MiseEntry } from "./mise-config.ts";
import type { Platform } from "./platform.ts";

/**
 * The spec every plugin package shares, and the core does not.
 *
 * The trailing hyphen is load-bearing: without it this matches
 * `npm:@reddb-io/red-skills` too.
 */
export const REDSKILLS_PLUGIN_PREFIX = "npm:@reddb-io/red-skills-";

/** The plugin entries this platform's manifest projects, in manifest order. */
export function redSkillsPluginEntries(
  p: Platform,
  tools: readonly Tool[] = TOOLS,
): MiseEntry[] {
  return miseEntries(p, tools).filter((e) => e.spec.startsWith(REDSKILLS_PLUGIN_PREFIX));
}

/**
 * The names the agent hosts know them by: `dev`, `memory`, `brain`.
 *
 * Manifest order is preserved, because it is the order the plugins have
 * to be installed in — `memory` declares `dev` as a dependency, and a
 * host asked for the dependent first is a host that can fail on a clean
 * machine for a reason nothing on screen explains.
 */
export function redSkillsPluginNames(p: Platform, tools: readonly Tool[] = TOOLS): string[] {
  return redSkillsPluginEntries(p, tools).map((e) => e.spec.slice(REDSKILLS_PLUGIN_PREFIX.length));
}

/**
 * The plugin switched on in the coder hosts when nobody chose otherwise.
 *
 * Spec #201 draws the line here: the package set carries every payload, so
 * that activating another one later is a flag rather than a download, and
 * only what was chosen is switched on. `dev` is the global process surface
 * everybody wants; Memory and Brain must not start acting on a machine
 * because they happened to be in the tarball — each of them ships hooks
 * and MCP servers that run on every session of a host they are installed
 * into, so "off" has to mean not installed there at all.
 *
 * The choice is made in the interview and recorded as a preference
 * (`redSkillsPlugins`); the offline depot alone stays pinned to this one,
 * because a depot is a signed medium and its activation is part of what
 * was signed.
 *
 * It lives beside the manifest projection rather than beside the host
 * adapters because both sides need it and neither may own it: the set is
 * composed with an activation config that says which plugins the
 * generators render, and the hosts are handed the same set to install. Two
 * spellings of "only dev" is one more pair that can disagree.
 */
export const ACTIVATED_PLUGIN = "dev";

/** What the interview arrives with: `dev` on, everything else off. */
export const DEFAULT_ACTIVATED_PLUGINS: readonly string[] = [ACTIVATED_PLUGIN];

/**
 * What a plugin needs switched on beside it.
 *
 * `memory` declares `dev` in its plugin.json, and a host handed the
 * dependent without its dependency is a host that fails on a clean
 * machine for a reason nothing on screen explains. Spelled here rather
 * than read out of the tree because the choice is made before any tree
 * exists on the machine.
 */
export const PLUGIN_DEPENDENCIES: Readonly<Record<string, readonly string[]>> = {
  memory: ["dev"],
};

export interface PluginChoice {
  /** The name the hosts know it by. */
  key: string;
  label: string;
  note: string;
}

/** The plugins the interview offers, in the order the manifest installs them. */
export const PLUGIN_CHOICES: readonly PluginChoice[] = [
  {
    key: "dev",
    label: "dev",
    note: "engineering skills, hooks and MCPs for coding agents — the default",
  },
  {
    key: "memory",
    label: "memory",
    note: "governed operational memory on top of dev — session hooks and a recall MCP; off unless chosen",
  },
  {
    key: "brain",
    label: "brain",
    note: "a project-local knowledge repository — its own hooks and MCP; off unless chosen",
  },
];

/**
 * The activation set, out of everything the machine carries locally.
 *
 * `chosen` is what the person asked for; the answer is that closed over
 * the dependencies and narrowed to what the manifest declares, in
 * manifest order — which is the order the plugins have to be installed
 * in. Asking for `memory` alone therefore activates `dev, memory`, and
 * asking for a plugin the manifest does not carry activates nothing for
 * it rather than failing: the row is the opt-out this product already
 * has, and a stale preference must not turn into a host command.
 */
export function activatedPlugins(
  declared: readonly string[],
  chosen: readonly string[] = DEFAULT_ACTIVATED_PLUGINS,
): string[] {
  const wanted = new Set<string>();
  const add = (name: string): void => {
    if (wanted.has(name)) return;
    wanted.add(name);
    for (const dependency of PLUGIN_DEPENDENCIES[name] ?? []) add(dependency);
  };
  for (const name of chosen) add(name);
  return declared.filter((name) => wanted.has(name));
}

/**
 * The recorded choice, read defensively.
 *
 * The preferences file is JSON a person edits. Anything that is not a
 * list of plugin names is the default rather than an error — a corrupt
 * field must not switch every plugin off, and must not switch one on.
 */
export function chosenPluginsFrom(recorded: unknown): string[] {
  if (!Array.isArray(recorded)) return [...DEFAULT_ACTIVATED_PLUGINS];
  return recorded.filter(
    (name): name is string => typeof name === "string" && /^[a-z][a-z0-9-]*$/.test(name),
  );
}

/** What this machine chose to switch on, or the default when nothing was chosen. */
export async function chosenPlugins(p: Platform): Promise<string[]> {
  const { readPreferences } = await import("./preferences.ts");
  return chosenPluginsFrom((await readPreferences(p)).redSkillsPlugins);
}

/** The activation set for this machine: its choice over what its manifest declares. */
export async function resolveActivatedPlugins(
  p: Platform,
  tools: readonly Tool[] = TOOLS,
): Promise<string[]> {
  return activatedPlugins(redSkillsPluginNames(p, tools), await chosenPlugins(p));
}
