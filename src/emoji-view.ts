/**
 * The emoji picker, drawn.
 *
 * Everything this reacts to is decided in src/emoji.ts — which rows are
 * visible, where the cursor is, what a keystroke means, what Enter
 * copies and through which bridge. What is left here is the part a test
 * cannot read anyway: a frame, a list, and a status line. The same split
 * keys-view.ts makes with src/keys.ts, and for the same reason: a picker
 * whose behaviour only exists inside a render is a picker nothing can
 * pin.
 *
 * One render, like everywhere else in this codebase. The command starts
 * it, the person leaves it, and the clipboard write is a bounded child
 * process rather than anything drawn in here.
 */

import {
  Box,
  ListItem,
  Text,
  render,
  useApp,
  useInput,
  useState,
  useTerminalSize,
} from "tuiuiu.js";
import { VERSION } from "./cli.ts";
import {
  clipboardRoute,
  copyEmoji,
  emojiColumns,
  emojiRow,
  searchEmoji,
  EMOJI,
  PICKER_START,
  pickerStep,
  type CopyOutcome,
  type Emoji,
  type PickerState,
} from "./emoji.ts";
import type { Platform } from "./platform.ts";
import { CenteredScreen, centeredFrame, Header, StatusLine, Surface } from "./tui-chrome.ts";
import { muted, subtle, text } from "./tui-theme.ts";
import { withConsoleSelectionSuspended } from "./windows-console-mode.ts";

/** The slice of the table that fits, kept around the cursor. */
function windowOf(items: readonly Emoji[], index: number, rows: number): Emoji[] {
  if (items.length <= rows) return [...items];
  const from = Math.max(0, Math.min(items.length - rows, index - Math.floor(rows / 2)));
  return items.slice(from, from + rows);
}

/**
 * The terminal to draw on, when it is not this process's own. Only a
 * test passes these — the same seam the keys viewer opens, for the same
 * reason.
 */
export interface PickerIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/**
 * Draw it, and return when the person leaves.
 *
 * `copy` is a parameter for the same reason the keys viewer's `fire` is:
 * it is the one thing in here that starts a process, and a caller that
 * wants the picker without touching the clipboard — a screenshot, a
 * smoke test — should not have to overwrite what somebody had copied.
 */
export async function runEmojiPicker(
  p: Platform,
  table: readonly Emoji[] = EMOJI,
  copy: (emoji: Emoji) => Promise<CopyOutcome> = (emoji) => copyEmoji(p, emoji),
  io?: PickerIo,
): Promise<void> {
  // Read once, outside the component: it is a property of the machine,
  // not of the frame, and asking per render would put a platform check
  // in the draw path.
  const route = clipboardRoute(p);
  const cols = emojiColumns(table);

  function App() {
    // exit() from useApp rather than process.exit, so waitUntilExit
    // resolves and the caller gets its terminal back.
    const { exit } = useApp();
    const size = useTerminalSize();
    const [state, setState] = useState<PickerState>(PICKER_START);
    const [status, setStatus] = useState("");

    useInput((input, key) => {
      const step = pickerStep(state(), input, key, table);
      setState(step.state);
      if (step.quit) {
        exit();
        return;
      }
      const chosen = step.copy;
      if (!chosen) return;
      // Said before it is done: the WSL bridge crosses into Windows and
      // takes a moment, and a picker that shows nothing in that moment
      // reads as an Enter that did not register.
      setStatus(`copying ${chosen.char}…`);
      void copy(chosen)
        .then((outcome) => setStatus(outcome.detail))
        .catch((err: unknown) => setStatus(`failed: ${(err as Error).message}`));
    });

    const width = Math.max(size.columns ?? 80, 60);
    const height = Math.max(size.rows ?? 24, 16);
    const frame = centeredFrame(width, height, 112, 34);
    const rows = Math.max(4, frame.height - 12);

    const query = state().query;
    const visible = searchEmoji(query, table);
    // Clamped for drawing only. The model clamps what it stores; a
    // filter that shrank the list under a cursor still holds an index
    // one frame too large.
    const index = Math.min(state().index, Math.max(0, visible.length - 1));
    const shown = windowOf(visible, index, rows);
    const chosen = visible[index];

    return CenteredScreen(
      width,
      height,
      112,
      34,

      Header("red-dev emoji", `${visible.length}/${table.length}`),
      Text({}, ""),

      // The search box, always visible and never modal: this is a picker
      // you type into, so the query is part of the frame rather than a
      // prompt that has to be opened first.
      Text(
        { color: query === "" ? subtle : text },
        query === "" ? "search: type to filter" : `search: ${query}`,
      ),
      Text({}, ""),

      Box(
        {},
        Surface(
          frame.width,
          rows + 2,
          ...(shown.length === 0
            ? [Text({ color: muted }, `nothing matches ${query}`)]
            : shown.map((emoji) =>
                ListItem({
                  primary: emojiRow(emoji, cols),
                  selected: emoji.char === chosen?.char,
                }),
              )),
        ),
      ),

      Text({}, ""),
      // Where Enter would put it, stated before it is pressed. A picker
      // that only mentions the clipboard once it has failed to reach one
      // is a picker somebody uses twice before finding out.
      Text(
        { color: route ? text : muted },
        route ? `enter copies through ${route.note}` : `no clipboard on ${p.env} — enter says so`,
      ),
      // The outcome of the last Enter, kept on screen until the next one.
      Text({ color: muted }, status()),

      StatusLine(
        "type to search · up/down move · enter copy · esc clear, then quit",
        `red-dev ${VERSION}`,
      ),
    );
  }

  await withConsoleSelectionSuspended(async () => {
    const { waitUntilExit } = render(App, { fullHeight: true, ...io });
    await waitUntilExit();
  });
}
