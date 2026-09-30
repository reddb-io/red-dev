/** Desktop applications that are optional choices, separate from CLI agents and terminal tools. */

import { isInstalled, providerFor, toolsInScope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { Choice } from "./tui-setup-model.ts";

const DESKTOP_APP_LABELS: Readonly<Record<string, string>> = {
  "codex-desktop": "Codex Desktop (ChatGPT)",
  "claude-desktop": "Claude Desktop",
  antigravity: "Antigravity",
  vscode: "Visual Studio Code",
  t3code: "T3 Code",
};

export const DESKTOP_APP_NAMES = new Set(Object.keys(DESKTOP_APP_LABELS));

export function desktopAppChoices(p: Platform): Choice[] {
  if (!p.caps.gui) return [];
  return toolsInScope("optional")
    .filter((tool) => DESKTOP_APP_NAMES.has(tool.name))
    .filter((tool) => providerFor(tool, p).kind !== "skip")
    .map((tool) => ({
      key: tool.name,
      label: DESKTOP_APP_LABELS[tool.name]!,
      note: `${tool.about ?? tool.name}${isInstalled(tool) ? " — installed" : ""}`,
    }));
}
