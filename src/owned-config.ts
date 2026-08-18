/**
 * Owning one field of a file somebody else wrote.
 *
 * Adopting RedSkills must not cost an operator the settings they already
 * had. Every host in the reconciliation registry keeps its configuration
 * in a file the user is free to edit — MCP servers they added by hand, a
 * model they pinned, a theme — and red-dev needs exactly one entry inside
 * some of those files. The obvious way to write it is the way the rest of
 * this repo has always done it: parse, spread, `JSON.stringify(…, null, 2)`,
 * write back. That is a rewrite of the whole document.
 *
 * A rewrite is not a data loss on the first converge, and it is not one on
 * the tenth either — the values survive. What does not survive is
 * everything the encoder has no opinion about: key order, the operator's
 * four-space indent, the blank line they left between two blocks, the
 * trailing newline they did not want. A file the user recognises becomes a
 * file they have to re-read, and a diff in their dotfiles repository stops
 * being about what changed. Worse, it happens on *every* converge that
 * reformats differently from the last writer, so the noise is permanent.
 *
 * So this module edits the text instead of the value. It finds the span of
 * the one entry it owns, splices a new one in, and returns the document
 * with every other byte exactly where it was. Adding a field appends one
 * line in the indentation its neighbours use; removing it takes that line
 * and its separator away again. Nothing else in the file is even read as
 * anything other than characters to keep.
 *
 * ## Refusing rather than repairing
 *
 * The first thing `setOwnedField` does is `JSON.parse` the document, and
 * it throws when that fails. A file we cannot read is a file whose author
 * is doing something we do not understand — a comment, a trailing comma, a
 * half-finished edit — and splicing into it on a guess is how a config the
 * host still loads becomes one it does not. The reconciliation above
 * reports that as a host it could not converge, which is the honest
 * answer, and leaves the file alone. `dropOwnedField` goes further and
 * returns the text unchanged: uninstalling is never a reason to hand
 * somebody back a file we broke.
 *
 * ## Pointers, and the parent we may have created
 *
 * A field is addressed by a pointer — `["mcpServers", "red-skills"]` — and
 * a missing intermediate object is created along with it. That matters at
 * removal time: the `mcpServers` block might be ours, made to hold the one
 * entry we own, or it might be the operator's with our entry alongside
 * theirs. `onlyWhenEmpty` is how the caller says "and take the parent too,
 * but only if nothing else is left in it", which is the only version of
 * that question with a safe answer.
 */

/** How a field is addressed: one key per level, outermost first. */
export type OwnedPointer = readonly string[];

/** What an unindented document is written with when it has no example. */
const DEFAULT_UNIT = "  ";

/** One `"key": value` pair, and where its parts sit in the text. */
interface Entry {
  key: string;
  /** The opening quote of the key. */
  entryStart: number;
  /** One past the last byte of the value. */
  entryEnd: number;
  valueStart: number;
  valueEnd: number;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && isSpace(text.charAt(i))) i++;
  return i;
}

/**
 * The string starting at `i`, and where it ends.
 *
 * The raw bytes are collected rather than unescaped by hand, and handed to
 * `JSON.parse` to decode: `é` and `\\` have exactly one correct
 * reading and it is not worth a second implementation of it here.
 */
function readString(text: string, i: number): { value: string; end: number } {
  let j = i + 1;
  let raw = "";
  while (j < text.length) {
    const ch = text.charAt(j);
    if (ch === "\\") {
      raw += text.slice(j, j + 2);
      j += 2;
      continue;
    }
    if (ch === '"') return { value: JSON.parse(`"${raw}"`) as string, end: j + 1 };
    raw += ch;
    j++;
  }
  throw new SyntaxError("unterminated string");
}

/** One past the end of the value starting at `i`, whatever kind it is. */
function skipValue(text: string, i: number): number {
  const ch = text.charAt(i);
  if (ch === '"') return readString(text, i).end;
  if (ch === "{" || ch === "[") {
    let depth = 0;
    let j = i;
    while (j < text.length) {
      const c = text.charAt(j);
      if (c === '"') {
        j = readString(text, j).end;
        continue;
      }
      if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) return j + 1;
      }
      j++;
    }
    throw new SyntaxError("unterminated container");
  }
  // A number, `true`, `false` or `null`: everything up to the separator.
  let j = i;
  while (j < text.length && !isSpace(text.charAt(j)) && !",}]".includes(text.charAt(j))) j++;
  return j;
}

/** Every entry of the object opening at `objStart`, and where it closes. */
function entriesOf(text: string, objStart: number): { entries: Entry[]; objEnd: number } {
  if (text.charAt(objStart) !== "{") throw new SyntaxError("not an object");
  const entries: Entry[] = [];
  let i = objStart + 1;
  for (;;) {
    i = skipSpace(text, i);
    const ch = text.charAt(i);
    if (ch === "}") return { entries, objEnd: i };
    if (ch !== '"') throw new SyntaxError("expected a key");
    const entryStart = i;
    const key = readString(text, i);
    i = skipSpace(text, key.end);
    if (text.charAt(i) !== ":") throw new SyntaxError("expected a colon");
    i = skipSpace(text, i + 1);
    const valueStart = i;
    const valueEnd = skipValue(text, i);
    entries.push({ key: key.value, entryStart, entryEnd: valueEnd, valueStart, valueEnd });
    i = skipSpace(text, valueEnd);
    if (text.charAt(i) === ",") i++;
  }
}

/** Where the document's single top-level object opens. */
function documentStart(text: string): number {
  const i = skipSpace(text, 0);
  if (text.charAt(i) !== "{") throw new SyntaxError("the document is not an object");
  return i;
}

/** The whitespace this line begins with, which is the indent to match. */
function indentAt(text: string, i: number): string {
  const line = text.lastIndexOf("\n", i - 1) + 1;
  const head = text.slice(line, i);
  return /^[ \t]*$/.test(head) ? head : "";
}

/**
 * The document's own indentation step, so an inserted block matches it.
 *
 * Read off the first indented key rather than configured: a file written
 * with four spaces should keep being written with four, and asking the
 * caller would be asking them to know something the file already says.
 */
function indentUnit(text: string): string {
  const match = /\n([ \t]+)"/.exec(text);
  return match?.[1] ?? DEFAULT_UNIT;
}

/** A value as text, with every line after the first put under `indent`. */
function render(value: unknown, indent: string, unit: string): string {
  const raw = JSON.stringify(value, null, unit) ?? "null";
  return raw.split("\n").map((line, at) => (at === 0 ? line : indent + line)).join("\n");
}

/** `{a: {b: value}}` out of `["a", "b"]` — the parents a set has to make. */
function nest(pointer: OwnedPointer, value: unknown): unknown {
  return pointer.reduceRight<unknown>((acc, key) => ({ [key]: acc }), value);
}

/** Put a key this object does not have beside the ones it does. */
function insert(
  text: string,
  objStart: number,
  objEnd: number,
  entries: readonly Entry[],
  key: string,
  value: unknown,
  unit: string,
): string {
  const last = entries[entries.length - 1];
  if (last) {
    const indent = indentAt(text, last.entryStart);
    const entry = `${JSON.stringify(key)}: ${render(value, indent, unit)}`;
    return `${text.slice(0, last.entryEnd)},\n${indent}${entry}${text.slice(last.entryEnd)}`;
  }
  // An empty object carries no example, so the enclosing line supplies it.
  const outer = indentAt(text, objStart);
  const indent = outer + unit;
  const entry = `${JSON.stringify(key)}: ${render(value, indent, unit)}`;
  return `${text.slice(0, objStart + 1)}\n${indent}${entry}\n${outer}${text.slice(objEnd)}`;
}

function spliceOwned(
  text: string,
  objStart: number,
  pointer: OwnedPointer,
  value: unknown,
  unit: string,
): string {
  const [head, ...rest] = pointer;
  if (head === undefined) throw new Error("an empty pointer owns the whole document");
  const { entries, objEnd } = entriesOf(text, objStart);
  const found = entries.find((entry) => entry.key === head);

  if (rest.length === 0) {
    if (!found) return insert(text, objStart, objEnd, entries, head, value, unit);
    const indent = indentAt(text, found.entryStart);
    return text.slice(0, found.valueStart) + render(value, indent, unit) + text.slice(found.valueEnd);
  }

  if (!found) return insert(text, objStart, objEnd, entries, head, nest(rest, value), unit);
  if (text.charAt(found.valueStart) !== "{") {
    throw new SyntaxError(`${head} is not an object, so ${rest.join(".")} cannot live under it`);
  }
  // The recursion edits strictly inside this value, so every offset
  // computed above it stays where it was.
  return spliceOwned(text, found.valueStart, rest, value, unit);
}

/**
 * The value at `pointer`, or undefined when nothing is there.
 *
 * Parsed rather than scanned: reading is the one direction where the
 * document's formatting does not matter, and `JSON.parse` is the reading
 * the host itself will do.
 */
export function readOwnedField(text: string, pointer: OwnedPointer): unknown {
  let node: unknown;
  try {
    node = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
  for (const key of pointer) {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return undefined;
    if (!Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/**
 * Write one field, leaving every other byte of the document alone.
 *
 * An empty document becomes `{ "<key>": … }`; a document that is not JSON
 * throws, because splicing into text we cannot read is how a config the
 * host still loads becomes one it does not.
 */
export function setOwnedField(text: string, pointer: OwnedPointer, value: unknown): string {
  const doc = text.trim() === "" ? "{}\n" : text;
  JSON.parse(doc);
  return spliceOwned(doc, documentStart(doc), pointer, value, indentUnit(doc));
}

/** Whether a value is an object with nothing in it. */
function isEmptyObject(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

/**
 * Take one field back out, and nothing else.
 *
 * The separator goes with it: an entry with a successor is removed up to
 * where that successor begins, so the whitespace the file used between
 * them stays exactly once; an entry that is last gives back the comma
 * before it instead. The only entry of an object collapses that object to
 * `{}` rather than leaving a blank line inside it.
 *
 * `onlyWhenEmpty` is for the parent object a set had to create: remove it
 * if the field we owned was all it ever held, and leave it where the
 * operator has since put something of their own beside ours.
 */
export function dropOwnedField(
  text: string,
  pointer: OwnedPointer,
  opts: { onlyWhenEmpty?: boolean } = {},
): string {
  if (text.trim() === "") return text;
  try {
    JSON.parse(text);
  } catch {
    // Uninstalling is never a reason to hand somebody back a broken file.
    return text;
  }
  if (opts.onlyWhenEmpty && !isEmptyObject(readOwnedField(text, pointer))) return text;

  let objStart: number;
  try {
    objStart = documentStart(text);
  } catch {
    return text;
  }

  // Walk to the object holding the last key, refusing to guess at any
  // level that is not there: nothing to remove is already the outcome.
  const parents = pointer.slice(0, -1);
  const key = pointer[pointer.length - 1];
  if (key === undefined) return text;
  for (const step of parents) {
    const { entries } = entriesOf(text, objStart);
    const found = entries.find((entry) => entry.key === step);
    if (!found || text.charAt(found.valueStart) !== "{") return text;
    objStart = found.valueStart;
  }

  const { entries, objEnd } = entriesOf(text, objStart);
  const at = entries.findIndex((entry) => entry.key === key);
  if (at < 0) return text;
  const entry = entries[at] as Entry;
  const next = entries[at + 1];
  const previous = entries[at - 1];
  if (next) return text.slice(0, entry.entryStart) + text.slice(next.entryStart);
  if (previous) return text.slice(0, previous.entryEnd) + text.slice(entry.entryEnd);
  return text.slice(0, objStart + 1) + text.slice(objEnd);
}
