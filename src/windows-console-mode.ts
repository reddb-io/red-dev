/**
 * Keep a fullscreen view alive in the classic Windows Console Host.
 *
 * QuickEdit is useful at a prompt, but in a live interface a mouse drag
 * enters selection mode and Console Host pauses the attached process.
 * Nothing in the application gets a signal or a key while it is paused;
 * Enter merely ends the selection, which makes a long-running install
 * look as though Enter was the missing answer.
 */

export const ENABLE_QUICK_EDIT_MODE = 0x0040;
export const ENABLE_EXTENDED_FLAGS = 0x0080;

export interface ConsoleModePort {
  read: () => number;
  write: (mode: number) => boolean;
  close: () => void;
}

type OpenConsoleMode = () => Promise<ConsoleModePort | null>;

/**
 * Disable selection-driven process suspension for exactly one view.
 *
 * The original mode is restored byte-for-byte, including on exceptions.
 * Failure to reach the Windows API is deliberately non-fatal: a console
 * guard must never become the reason the interface cannot start.
 */
export async function withConsoleSelectionSuspended<T>(
  view: () => Promise<T>,
  platform: NodeJS.Platform = process.platform,
  open: OpenConsoleMode = openWindowsConsoleMode,
): Promise<T> {
  if (platform !== "win32") return await view();

  let port: ConsoleModePort | null = null;
  try {
    port = await open();
  } catch {
    return await view();
  }
  if (!port) return await view();

  let original: number;
  let changed = false;
  try {
    original = port.read();
    const guarded = (original | ENABLE_EXTENDED_FLAGS) & ~ENABLE_QUICK_EDIT_MODE;
    changed = guarded !== original && port.write(guarded);
  } catch {
    port.close();
    return await view();
  }

  try {
    return await view();
  } finally {
    if (changed) port.write(original);
    port.close();
  }
}

/** The real Console Host input mode, loaded only by a native Windows build. */
async function openWindowsConsoleMode(): Promise<ConsoleModePort | null> {
  const { dlopen } = await import("bun:ffi");
  const kernel = dlopen("kernel32.dll", {
    GetStdHandle: { args: ["i32"], returns: "ptr" },
    GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
    SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
  });
  const input = kernel.symbols.GetStdHandle(-10); // STD_INPUT_HANDLE
  if (!input) {
    kernel.close();
    return null;
  }

  const mode = new Uint32Array(1);
  const read = (): number => {
    if (kernel.symbols.GetConsoleMode(input, mode) === 0) throw new Error("GetConsoleMode failed");
    return mode[0] ?? 0;
  };

  // Prove this really is a console handle before handing it to the view.
  try {
    read();
  } catch {
    kernel.close();
    return null;
  }

  return {
    read,
    write: (next) => kernel.symbols.SetConsoleMode(input, next >>> 0) !== 0,
    close: () => kernel.close(),
  };
}
