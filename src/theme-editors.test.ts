import { describe, expect, test } from "bun:test";
import { codeArgv, gnomeColorScheme, vscodeSettingsJson } from "./theme-editors.ts";
import { THEMES } from "./themes.ts";

describe("codeArgv", () => {
  test("wraps a .cmd on Windows, because CreateProcess cannot run one", () => {
    // The bug: every theme change on Windows reported "could not install
    // <extension>" on a machine with VS Code installed, because
    // code.cmd was spawned directly and failed before reaching the CLI.
    expect(codeArgv(["C:\\VS Code\\bin\\code.cmd", "--version"], "win32")).toEqual([
      "cmd.exe",
      "/c",
      "C:\\VS Code\\bin\\code.cmd",
      "--version",
    ]);
  });

  test("leaves a real executable alone", () => {
    expect(codeArgv(["C:\\VS Code\\code.exe", "--version"], "win32")).toEqual([
      "C:\\VS Code\\code.exe",
      "--version",
    ]);
  });

  test("leaves Linux alone, where code is a real binary", () => {
    expect(codeArgv(["/usr/bin/code", "--version"], "linux")).toEqual([
      "/usr/bin/code",
      "--version",
    ]);
  });

  test("does not wrap a path that merely contains .cmd", () => {
    expect(codeArgv(["C:\\cmd.tools\\code.exe"], "win32")).toEqual(["C:\\cmd.tools\\code.exe"]);
  });
});

describe("VS Code themes", () => {
  test("themes settings.json that contains comments and a trailing comma", () => {
    const next = vscodeSettingsJson(
      `{
  // kept by VS Code
  "editor.fontFamily": "FiraCode Nerd Font",
  "workbench.colorTheme": "Default Dark Modern",
}
`,
      "Tokyo Night",
    );

    expect(JSON.parse(next)).toEqual({
      "editor.fontFamily": "FiraCode Nerd Font",
      "workbench.colorTheme": "Tokyo Night",
    });
  });

});

describe("gnomeColorScheme", () => {
  test("follows the theme's declared appearance, not a guess at its palette", () => {
    expect(gnomeColorScheme(THEMES.light)).toBe("prefer-light");
    expect(gnomeColorScheme(THEMES.marble)).toBe("prefer-light");
    expect(gnomeColorScheme(THEMES.dark)).toBe("prefer-dark");
    expect(gnomeColorScheme(THEMES.obsidian)).toBe("prefer-dark");
  });
});
