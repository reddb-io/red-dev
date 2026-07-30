#!/usr/bin/env bun
/** Renders the fullscreen setup wizard on its theme step. */
import { Box, HintBar, ListItem, Panel, ProgressBar, Text, renderToString } from "tuiuiu.js";
import { THEMES, themeNames } from "../src/themes.ts";

const steps = ["Terminal", "Agents", "Runtimes", "Optional tools", "ble.sh", "Font", "Theme"];
const stepIndex = 6;
const cursor = 4; // kanagawa
const names = themeNames();
const active = names[cursor]!;
const c = THEMES[active]!.terminal;
const palette = [c.background, c.red, c.green, c.yellow, c.blue, c.purple, c.cyan, c.foreground];

console.log(
  renderToString(
    Box(
      { flexDirection: "column", padding: 1 },
      Box(
        { flexDirection: "row", justifyContent: "space-between" },
        Text({ color: "red", bold: true }, "red-dev setup"),
        Text({ dim: true }, "os=windows env=windows arch=x64"),
      ),
      Box(
        { marginTop: 1, marginBottom: 1 },
        ProgressBar({ value: stepIndex, max: steps.length, width: 48, style: "block", color: "red" }),
      ),
      Box(
        { flexDirection: "row" },
        Box(
          { width: 22 },
          Panel(
            { title: "steps" },
            ...steps.map((s, i) =>
              ListItem({
                primary: s,
                selected: i === stepIndex,
                status: i < stepIndex ? "success" : i === stepIndex ? "running" : "pending",
              }),
            ),
          ),
        ),
        Box(
          { width: 52, marginLeft: 1 },
          Panel(
            { title: "theme" },
            Text({ dim: true }, "One palette reaches the terminal, zellij, btop, Neovim, VS Code, GNOME and the wallpaper."),
            Text({}, ""),
            ...names.slice(2, 7).map((n, i) =>
              ListItem({
                primary: THEMES[n]?.name ?? n,
                secondary: `neovim: ${THEMES[n]?.neovim ?? "-"}`,
                selected: i + 2 === cursor,
              }),
            ),
            Text({}, ""),
            Box({ flexDirection: "row" }, ...palette.map((h) => Text({ backgroundColor: h }, "    "))),
          ),
        ),
      ),
      Box(
        { marginTop: 1 },
        HintBar({
          hints: [
            { shortcut: "up/down", action: "move" },
            { shortcut: "enter", action: "finish" },
            { shortcut: "left", action: "back" },
            { shortcut: "q", action: "skip setup" },
          ],
        }),
      ),
    ),
  ),
);
