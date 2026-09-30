import { describe, expect, test } from "bun:test";
import { AGENTS } from "./agents.ts";
import { desktopAppChoices } from "./desktop-apps.ts";
import { otherOptionalChoices } from "./red-family.ts";
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
    expect(page.choices.map((choice) => choice.key)).toEqual([
      "codex-desktop", "claude-desktop", "antigravity", "vscode",
    ]);
    expect(AGENTS.map((agent) => agent.key)).not.toContain("codex-desktop");
    expect(AGENTS.map((agent) => agent.key)).not.toContain("claude-desktop");
    expect(AGENTS.map((agent) => agent.key)).not.toContain("t3code");
    expect(AGENTS.map((agent) => agent.key)).not.toContain("antigravity");
    expect(AGENTS.map((agent) => agent.key)).not.toContain("vscode");

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

  test("offer all four apps on Ubuntu 24/26 and keep them out of other setup pages", () => {
    for (const version of ["24.04", "26.04"]) {
      for (const arch of ["x64", "arm64"] as const) {
        const platform = { ...DESKTOP, version, arch };
        const choices = desktopAppChoices(platform);
        expect(choices.map((choice) => choice.label)).toEqual([
          "Codex Desktop (ChatGPT)", "Claude Desktop", "Antigravity", "Visual Studio Code",
        ]);
        expect(otherOptionalChoices(platform).map((choice) => choice.key))
          .not.toContain("antigravity");
        expect(otherOptionalChoices(platform).map((choice) => choice.key))
          .not.toContain("vscode");
      }
    }
    expect(desktopAppChoices({ ...DESKTOP, env: "server", caps: { ...DESKTOP.caps, gui: false } }))
      .toEqual([]);
    expect(desktopAppChoices({ ...DESKTOP, env: "wsl", caps: { ...DESKTOP.caps, gui: false } }))
      .toEqual([]);
  });

  test("use official package channels for Antigravity and VS Code on both OSes", () => {
    const antigravity = TOOLS.find((tool) => tool.name === "antigravity")!;
    const vscode = TOOLS.find((tool) => tool.name === "vscode")!;
    expect(providerFor(antigravity, DESKTOP)).toMatchObject({
      kind: "aptrepo", pkgs: ["antigravity"],
      keyUrl: "https://us-central1-apt.pkg.dev/doc/repo-signing-key.gpg",
    });
    expect(providerFor(vscode, DESKTOP)).toMatchObject({
      kind: "aptrepo", pkgs: ["code"],
      keyUrl: "https://packages.microsoft.com/keys/microsoft.asc",
    });
    const windows: Platform = {
      ...DESKTOP, os: "windows", env: "windows", distro: null, version: null, codename: null,
      caps: { ...DESKTOP.caps, apt: false, systemd: false, winget: true },
    };
    expect(providerFor(antigravity, windows)).toEqual({ kind: "winget", id: "Google.Antigravity" });
    expect(providerFor(vscode, windows)).toEqual({ kind: "winget", id: "Microsoft.VisualStudioCode" });
    expect(desktopAppChoices(windows).map((choice) => choice.key)).toEqual([
      "codex-desktop", "claude-desktop", "antigravity", "vscode", "t3code",
    ]);
    expect(antigravity.scope).toBe("optional");
    expect(vscode.scope).toBe("optional");
  });
});
