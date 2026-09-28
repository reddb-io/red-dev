/**
 * Alt+Enter, kept distinguishable through zellij.
 *
 * red-dev runs zellij with the kitty keyboard protocol off, so zellij
 * forwards Alt+Enter as ESC CR. A pane app cannot tell those two bytes
 * from a lone Escape followed by Enter, nor from the ESC CR some
 * terminals send for Shift+Enter. The zellij keybind writes the key's
 * CSI-u spelling instead — ESC[13;3u, 13 for Enter and 3 for 1 plus the
 * alt bit — and readline maps that sequence to the newline ble.sh
 * already inserts for M-RET, so the shell never echoes raw bytes.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { composeZellijConfig } from "./zellij-layer.ts";

const ALT_ENTER = "\u001b[13;3u";

const root = `${import.meta.dir}/..`;
const inputrc = readFileSync(`${root}/config/bash/inputrc.conf`, "utf8");
const zellij = readFileSync(`${root}/config/zellij/config.kdl`, "utf8");

const decimalBytes = [...ALT_ENTER].map((c) => c.codePointAt(0)).join(" ");
const binding = `bind "Alt Enter" { Write ${decimalBytes}; }`;

describe("Alt+Enter through zellij", () => {
  test("is written through as ESC[13;3u in the modes typing reaches", () => {
    const shared = zellij.indexOf('shared_among "locked" "normal" {');
    const close = zellij.indexOf("}\n    locked {", shared);
    expect(shared).toBeGreaterThan(-1);
    expect(zellij.slice(shared, close)).toContain(binding);
  });

  test("survives a user layer that binds other keys in the same modes", () => {
    const composed = composeZellijConfig(
      zellij,
      'keybinds {\n    shared_among "locked" "normal" {\n        bind "Ctrl Tab" { GoToNextTab; }\n    }\n}\n',
    );
    expect(composed).toContain(binding);
    expect(composed).toContain('bind "Ctrl Tab" { GoToNextTab; }');
  });
});

describe("bash turns it into a newline", () => {
  test("readline inserts a newline instead of printing the bytes", () => {
    expect(inputrc).toContain(`"${ALT_ENTER.replace("\u001b", "\\e")}": "\\C-q\\C-j"`);
  });
});
