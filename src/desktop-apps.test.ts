import { describe, expect, test } from "bun:test";
import { AGENTS } from "./agents.ts";
import { desktopAppChoices } from "./desktop-apps.ts";
import { TOOLS, providerFor } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { questions, selectedSetupApps } from "./tui-setup-model.ts";

const DESKTOP: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

describe("optional desktop apps", () => {
  test("have their own opt-in setup page and never enter the agent catalogue", () => {
    const desktopApps = desktopAppChoices(DESKTOP);
    const steps = questions(DESKTOP, [], [], [], [], [], {}, desktopApps);
    const page = steps.find((step) => step.id === "desktop-apps")!;

    expect(page.title).toBe("Desktop apps");
    expect(page.preset).toEqual([]);
    expect(page.choices.map((choice) => choice.key)).toEqual(["codex-desktop", "claude-desktop"]);
    expect(AGENTS.map((agent) => agent.key)).not.toContain("codex-desktop");
    expect(AGENTS.map((agent) => agent.key)).not.toContain("claude-desktop");
    expect(AGENTS.map((agent) => agent.key)).not.toContain("t3code");

    const picked = (id: string) => id === "desktop-apps" ? ["codex-desktop"] : [];
    expect(selectedSetupApps(steps, picked)).toEqual(["codex-desktop"]);
  });

  test("use the publishers' official Linux delivery paths", () => {
    const codex = TOOLS.find((tool) => tool.name === "codex-desktop")!;
    const claude = TOOLS.find((tool) => tool.name === "claude-desktop")!;
    const codexProvider = providerFor(codex, DESKTOP);
    const claudeProvider = providerFor(claude, DESKTOP);

    expect(codexProvider.kind).toBe("deb");
    if (codexProvider.kind === "deb") {
      expect(codexProvider.package).toBe("chatgpt");
      expect(codexProvider.urls.x64).toStartWith("https://persistent.oaistatic.com/");
    }
    expect(claudeProvider).toMatchObject({
      kind: "aptrepo",
      pkgs: ["claude-desktop"],
      keyUrl: "https://downloads.claude.ai/claude-desktop/key.asc",
    });
  });
});
