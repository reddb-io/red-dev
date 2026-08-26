/**
 * The RedDB family as it is presented during setup.
 *
 * The manifest remains the source of truth for whether a product exists on
 * this target and how it is installed. This file only gives those rows a
 * product-facing order and label. Base rows are inventory: the converge owns
 * them. Optional companion rows remain real choices and are projected back
 * into SetupAnswers.apps.
 */

import {
  applicableScopes,
  providerFor,
  TOOLS,
  toolsInScope,
  type Tool,
} from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { Choice } from "./tui-setup-model.ts";

export const RED_FAMILY_OPTIONAL = new Set([
  "red-skills-vscode",
  "red-skills-herdr",
]);

interface FamilyRow {
  tool: string;
  label: string;
  note?: string;
}

const FAMILY_ROWS: readonly FamilyRow[] = [
  { tool: "red-dev", label: "red-dev" },
  { tool: "red", label: "RedDB (red)" },
  { tool: "tq", label: "TOON (tq)" },
  { tool: "red-request", label: "red-request" },
  { tool: "red-ui", label: "red-ui" },
  { tool: "dit", label: "dit" },
  { tool: "red-skills-core", label: "RedSkills" },
  {
    tool: "red-skills-dev",
    label: "RedSkills · Dev plugin",
    note: "engineering skills — included and active globally",
  },
  {
    tool: "red-skills-memory",
    label: "RedSkills · Memory plugin",
    note: "governed operational memory — included; activation stays project-scoped",
  },
  {
    tool: "red-skills-brain",
    label: "RedSkills · Brain plugin",
    note: "project knowledge graph — included; activation stays project-scoped",
  },
  { tool: "red-skills-vscode", label: "RedSkills · VS Code integration" },
  { tool: "red-skills-herdr", label: "RedSkills · Herdr integration" },
];

function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

function availableOn(tool: Tool, p: Platform): boolean {
  if (providerFor(tool, p).kind === "skip") return false;
  return tool.scope === "optional" || applicableScopes(p).includes(tool.scope);
}

/** The dedicated RedDB page, including RedCode's cross-reference to Agents. */
export function redFamilyChoices(p: Platform, agents: readonly Choice[]): Choice[] {
  const choices: Choice[] = [];

  for (const row of FAMILY_ROWS) {
    const tool = toolNamed(row.tool);
    if (!tool || !availableOn(tool, p)) continue;
    const optional = RED_FAMILY_OPTIONAL.has(tool.name);
    choices.push({
      key: tool.name,
      label: row.label,
      note: row.note ?? `${optional ? "optional" : "included"} — ${tool.about ?? tool.name}`,
      selectable: optional,
      ...(!optional ? { marker: "included" as const } : {}),
      ...(optional ? { answer: "apps" as const } : {}),
    });
  }

  const redcode = agents.find((agent) => agent.key === "redcode");
  if (redcode) {
    const beforeDit = choices.findIndex((choice) => choice.key === "dit");
    const afterRed = choices.findIndex((choice) => choice.key === "red") + 1;
    const at = beforeDit >= 0 ? beforeDit : Math.max(0, afterRed);
    const redcodeChoice: Choice = {
      ...redcode,
      label: "RedCode",
      note: `chosen on Agents — ${redcode.note}`,
      selectable: false,
      marker: "elsewhere",
    };
    return [...choices.slice(0, at), redcodeChoice, ...choices.slice(at)];
  }

  return choices;
}

/** Optional tools that remain on the generic Tools page. */
export function otherOptionalChoices(p: Platform): Choice[] {
  return toolsInScope("optional")
    .filter((tool) => !RED_FAMILY_OPTIONAL.has(tool.name))
    .filter((tool) => providerFor(tool, p).kind !== "skip")
    .map((tool) => ({ key: tool.name, label: tool.name, note: tool.about ?? "" }));
}
