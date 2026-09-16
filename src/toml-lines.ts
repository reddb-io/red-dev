/**
 * Just enough TOML structure to edit a person's file without reformatting it.
 *
 * A parser answers what a document means and throws away how it was
 * written: the comments, the blank lines, the order. Repairing a file that
 * red-dev promised to leave to its owner needs the other half — which
 * physical lines make up which statement, and which table each one sits
 * in — so an edit can move or remove exactly those lines and nothing else.
 *
 * Validity is not this module's question. Whoever edits with it asks a
 * real parser about the result (Bun.TOML at runtime, smol-toml in the
 * tests), because a hand scanner that also claimed to validate is how a
 * regex decided a file had no `[general]` table when it had one.
 */

export interface TomlLine {
  /** The line without its terminator. */
  readonly text: string;
  /** "\n", "\r\n", or "" for a last line with none. */
  readonly eol: string;
}

export type TomlStatement =
  | {
      readonly kind: "header";
      readonly line: number;
      /** Dotted name with whitespace and quotes removed: `[ general ]` is `general`. */
      readonly table: string;
      readonly array: boolean;
    }
  | {
      readonly kind: "assignment";
      /** First and last physical line, inclusive: a multi-line array is one statement. */
      readonly line: number;
      readonly end: number;
      /** The table it belongs to; "" is the root. */
      readonly table: string;
      /** Dotted key as written, normalised like `table`. */
      readonly key: string;
      /** Everything after the `=`, across every line of the statement. */
      readonly value: string;
    };

export function splitLines(text: string): TomlLine[] {
  if (text === "") return [];
  const out: TomlLine[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) {
      out.push({ text: text.slice(start), eol: "" });
      break;
    }
    const cr = nl > start && text[nl - 1] === "\r";
    out.push({ text: text.slice(start, cr ? nl - 1 : nl), eol: cr ? "\r\n" : "\n" });
    start = nl + 1;
  }
  return out;
}

export function joinLines(lines: readonly TomlLine[]): string {
  return lines.map((l) => l.text + l.eol).join("");
}

function normaliseName(name: string): string {
  return name
    .split(".")
    .map((part) => part.trim().replace(/^(['"])(.*)\1$/, "$2"))
    .join(".");
}

const HEADER = /^\s*(\[\[?)\s*([^\[\]#]+?)\s*(\]\]?)\s*(?:#.*)?$/;
const ASSIGNMENT = /^\s*((?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*')(?:\s*\.\s*(?:[A-Za-z0-9_-]+|"[^"]*"|'[^']*'))*)\s*=/;

/**
 * How the bracket depth and string state change across one stretch of value.
 *
 * Tracks what can carry a value over a line break — an open array or
 * inline table, a multi-line string — and ignores a `#` comment or a
 * bracket that sits inside a string.
 */
function scanValue(
  s: string,
  state: { depth: number; multiline: null | "'''" | '"""' },
): void {
  let i = 0;
  while (i < s.length) {
    if (state.multiline) {
      const close = s.indexOf(state.multiline, i);
      if (close === -1) return;
      i = close + 3;
      state.multiline = null;
      continue;
    }
    const c = s[i]!;
    if (c === "#") return;
    if (s.startsWith("'''", i) || s.startsWith('"""', i)) {
      state.multiline = s.slice(i, i + 3) as "'''" | '"""';
      i += 3;
      continue;
    }
    if (c === "'") {
      const close = s.indexOf("'", i + 1);
      i = close === -1 ? s.length : close + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (c === "[" || c === "{") state.depth += 1;
    else if (c === "]" || c === "}") state.depth -= 1;
    i += 1;
  }
}

/** Every header and assignment, in document order. Comments and blanks are not statements. */
export function statements(lines: readonly TomlLine[]): TomlStatement[] {
  const out: TomlStatement[] = [];
  let table = "";
  let i = 0;
  while (i < lines.length) {
    const text = lines[i]!.text;
    const header = HEADER.exec(text);
    if (header && header[1]!.length === header[3]!.length) {
      table = normaliseName(header[2]!);
      out.push({ kind: "header", line: i, table, array: header[1] === "[[" });
      i += 1;
      continue;
    }
    const assignment = ASSIGNMENT.exec(text);
    if (!assignment) {
      i += 1;
      continue;
    }
    const state = { depth: 0, multiline: null as null | "'''" | '"""' };
    const parts = [text.slice(assignment[0].length)];
    scanValue(parts[0]!, state);
    let end = i;
    while ((state.depth > 0 || state.multiline) && end + 1 < lines.length) {
      end += 1;
      parts.push(lines[end]!.text);
      scanValue(lines[end]!.text, state);
    }
    out.push({
      kind: "assignment",
      line: i,
      end,
      table,
      key: normaliseName(assignment[1]!),
      value: parts.join("\n"),
    });
    i = end + 1;
  }
  return out;
}

/**
 * The strings in an array value, in order, with comments skipped.
 *
 * Basic strings are unescaped for the escapes an import path can carry;
 * anything stranger is kept as written, which is still the entry's
 * identity for comparison.
 */
export function stringsIn(value: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < value.length) {
    const c = value[i]!;
    if (c === "#") {
      const nl = value.indexOf("\n", i);
      i = nl === -1 ? value.length : nl + 1;
      continue;
    }
    if (c === "'") {
      const close = value.indexOf("'", i + 1);
      if (close === -1) break;
      out.push(value.slice(i + 1, close));
      i = close + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < value.length && value[j] !== '"') {
        if (value[j] === "\\" && j + 1 < value.length) {
          const n = value[j + 1]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
          j += 2;
        } else {
          s += value[j];
          j += 1;
        }
      }
      out.push(s);
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** A TOML string for this value: literal where it can be, so backslashes stay readable. */
export function tomlString(s: string): string {
  if (!/['\r\n]/.test(s)) return `'${s}'`;
  return JSON.stringify(s);
}
