/**
 * The keys viewer, drawn.
 *
 * Everything this reacts to is decided in src/keys.ts — which rows are
 * visible, where the cursor is, what a keystroke means, what Enter
 * starts. What is left here is the part a test cannot read anyway: a
 * frame, a list, and a status line. That split is deliberate and is the
 * same one tui.ts makes with its install model: a viewer whose
 * behaviour only exists inside a render is a viewer nothing can pin.
 *
 * One render, like everywhere else in this codebase. The command starts
 * it, the person leaves it, and the terminal they may have just opened
 * is a detached process of its own rather than something drawn in here.
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
  detach,
  fireEntry,
  keyColumns,
  keyRow,
  searchKeys,
  VIEWER_START,
  viewerStep,
  type FireOutcome,
  type KeyEntry,
  type ViewerState,
} from "./keys.ts";
import type { Platform } from "./platform.ts";
import { CenteredScreen, centeredFrame, Header, StatusLine, Surface } from "./tui-chrome.ts";
import { muted, subtle, text } from "./tui-theme.ts";
import { withConsoleSelectionSuspended } from "./windows-console-mode.ts";

/**
 * The slice of a long list that fits, kept around the cursor.
 *
 * The registry is two actions today and will not stay that way; a list
 * that draws past the bottom of the frame overwrites what is already
 * there rather than clipping, which is the failure Surface's comment
 * describes.
 */
function windowOf(items: readonly KeyEntry[], index: number, rows: number): KeyEntry[] {
  if (items.length <= rows) return [...items];
  const from = Math.max(0, Math.min(items.length - rows, index - Math.floor(rows / 2)));
  return items.slice(from, from + rows);
}

/** What the panel under the list says about the highlighted row. */
function verdict(entry: KeyEntry | undefined): { line: string; color: string } {
  if (!entry) return { line: "", color: muted };
  if (entry.state === "bound") return { line: `bound — ${entry.chord}`, color: text };
  return { line: `unbound — ${entry.reason}`, color: muted };
}

/**
 * The terminal to draw on, when it is not this process's own.
 *
 * Only a test passes these, and the reason is the failure mode a model
 * test cannot see: a viewer whose keystrokes are decided perfectly and
 * never handed to the decider draws a list that ignores the keyboard,
 * and every unit test still passes. Feeding real bytes through the real
 * renderer is the only thing that catches it.
 */
export interface ViewerIo {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

/**
 * Draw it, and return when the person leaves.
 *
 * `fire` is a parameter for the same reason the model injects its spawn:
 * it is the one thing in here that starts a process, and a caller that
 * wants the viewer without that — a screenshot, a smoke test — should
 * not have to open a terminal to get it.
 */
export async function runKeysViewer(
  p: Platform,
  entries: readonly KeyEntry[],
  fire: (entry: KeyEntry) => Promise<FireOutcome> = (entry) => fireEntry(entry, p, detach),
  io?: ViewerIo,
): Promise<void> {
  function App() {
    // exit() from useApp rather than process.exit, so waitUntilExit
    // resolves and the caller gets its terminal back — the same rule
    // tui.ts follows.
    const { exit } = useApp();
    const size = useTerminalSize();
    const [state, setState] = useState<ViewerState>(VIEWER_START);
    const [status, setStatus] = useState("");

    useInput((input, key) => {
      const step = viewerStep(entries, state(), input, key);
      setState(step.state);
      if (step.quit) {
        exit();
        return;
      }
      const chosen = step.fire;
      if (!chosen) return;
      // Said before it is done: starting a Windows terminal crosses the
      // WSL boundary and takes a moment, and a viewer that shows nothing
      // in that moment reads as a key that did not register.
      setStatus(`starting ${chosen.label}…`);
      void fire(chosen)
        .then((outcome) => setStatus(outcome.detail))
        .catch((err: unknown) => setStatus(`failed: ${(err as Error).message}`));
    });

    const width = Math.max(size.columns ?? 80, 60);
    const height = Math.max(size.rows ?? 24, 16);
    const frame = centeredFrame(width, height, 112, 34);
    const rows = Math.max(4, frame.height - 12);

    const query = state().query;
    const visible = searchKeys(entries, query);
    // Clamped for drawing only. The model clamps what it stores; a
    // filter that shrank the list under a cursor still holds an index
    // one frame too large, and reading past the end here would draw an
    // empty highlight.
    const index = Math.min(state().index, Math.max(0, visible.length - 1));
    const cols = keyColumns(entries);
    const shown = windowOf(visible, index, rows);
    const chosen = visible[index];
    const said = verdict(chosen);

    return CenteredScreen(
      width,
      height,
      112,
      34,

      Header("red-dev keys", `${visible.length}/${entries.length}`),
      Text({}, ""),

      // The search box, always visible and never modal: this is a
      // viewer you type into, so the query is part of the frame rather
      // than a prompt that has to be opened first.
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
            : shown.map((entry) =>
                ListItem({
                  primary: keyRow(entry, cols),
                  selected: entry.id === chosen?.id,
                }),
              )),
        ),
      ),

      Text({}, ""),
      Text({ color: said.color }, said.line),
      // The outcome of the last Enter, kept on screen until the next
      // one. A launcher that says nothing after launching is
      // indistinguishable from one that did nothing.
      Text({ color: muted }, status()),

      StatusLine(
        "type to search · up/down move · enter run · esc clear, then quit",
        `red-dev ${VERSION}`,
      ),
    );
  }

  await withConsoleSelectionSuspended(async () => {
    const { waitUntilExit } = render(App, { fullHeight: true, ...io });
    await waitUntilExit();
  });
}
