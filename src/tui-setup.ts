/** Standalone entry into the same wizard the fullscreen menu hosts. */

import { render, useApp, useInput, useTerminalSize } from "tuiuiu.js";
import type { Platform } from "./platform.ts";
import { SetupLayout, useSetupModel, type setupSteps, type SetupAnswers } from "./tui-setup-model.ts";
import { withConsoleSelectionSuspended } from "./windows-console-mode.ts";

export async function runSetupTui(
  p: Platform,
  { steps, wizard }: ReturnType<typeof setupSteps>,
): Promise<SetupAnswers | null> {
  let result: SetupAnswers | null = null;

  function App() {
    const { exit } = useApp();
    const size = useTerminalSize();
    const model = useSetupModel(steps, wizard);
    useInput((input, key) => {
      const verdict = model.handleKey(input, key);
      if (verdict === "done") result = model.answers();
      if (verdict === "done" || verdict === "quit") exit();
    });
    return SetupLayout(model, p, size.columns ?? 90, size.rows ?? 24);
  }

  await withConsoleSelectionSuspended(async () => {
    const { waitUntilExit } = render(App, { fullHeight: true });
    await waitUntilExit();
  });
  return result;
}
