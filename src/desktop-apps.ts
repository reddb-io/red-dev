/** Desktop applications that are optional choices, separate from CLI agents and terminal tools. */

import { isInstalled, providerFor, toolsInScope } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import type { Choice } from "./tui-setup-model.ts";

export const DESKTOP_APP_NAMES = new Set(["codex-desktop", "claude-desktop", "t3code"]);

export function desktopAppChoices(p: Platform): Choice[] {
  if (!p.caps.gui) return [];
  return toolsInScope("optional")
    .filter((tool) => DESKTOP_APP_NAMES.has(tool.name))
    .filter((tool) => providerFor(tool, p).kind !== "skip")
    .map((tool) => ({
      key: tool.name,
      label: tool.name === "codex-desktop"
        ? "Codex Desktop (ChatGPT)"
        : tool.name === "claude-desktop"
          ? "Claude Desktop"
          : "T3 Code",
      note: `${tool.about ?? tool.name}${isInstalled(tool) ? " — installed" : ""}`,
    }));
}
