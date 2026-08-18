/**
 * What a field red-dev owns costs the rest of the file: nothing.
 *
 * The observable held here is bytes, not values. A merge that keeps every
 * setting and reflows the document has lost the argument — the operator
 * still has to re-read a file they wrote, and their dotfiles diff is noise
 * on every converge. So each case below asserts the exact text outside the
 * one entry we touched, which is the only assertion that can tell a real
 * splice from a re-encode that happened to agree this time.
 */

import { describe, expect, test } from "bun:test";

import { dropOwnedField, readOwnedField, setOwnedField } from "./owned-config.ts";

/** A settings file with an operator's own hand all over it. */
const USER = `{
  "theme": "GitHub Dark",
  "mcpServers": {
    "their-own": {
      "command": "node",
      "args": ["/home/someone/tools/server.mjs"]
    }
  },
  "autoAccept": false
}
`;

const OURS = { command: "bun", args: ["run", "/red-skills/current/bin/mcp.mjs"] };

describe("writing a field we own", () => {
  test("changes only the bytes of that field", () => {
    const after = setOwnedField(USER, ["mcpServers", "red-skills"], OURS);

    // Everything the operator wrote is still there, character for
    // character — including the four lines of the server they added.
    expect(after).toContain(`  "theme": "GitHub Dark",\n`);
    expect(after).toContain(`      "args": ["/home/someone/tools/server.mjs"]\n`);
    expect(after).toContain(`  "autoAccept": false\n`);
    expect(after.endsWith("}\n")).toBe(true);
    // And the file is still a file.
    expect(readOwnedField(after, ["mcpServers", "red-skills"])).toEqual(OURS);
    expect(readOwnedField(after, ["mcpServers", "their-own", "command"])).toBe("node");
  });

  test("and puts it back byte for byte when it is removed again", () => {
    // The property the uninstall contract rests on: adopting RedSkills
    // and then dropping it leaves the operator with the file they had.
    const after = setOwnedField(USER, ["mcpServers", "red-skills"], OURS);
    expect(dropOwnedField(after, ["mcpServers", "red-skills"])).toBe(USER);
  });

  test("matches the indentation the file already uses", () => {
    const four = `{\n    "theme": "dark"\n}\n`;
    const after = setOwnedField(four, ["mcpServers", "red-skills"], { command: "bun" });

    expect(after).toBe(
      `{\n    "theme": "dark",\n    "mcpServers": {\n        "red-skills": {\n            "command": "bun"\n        }\n    }\n}\n`,
    );
    expect(dropOwnedField(after, ["mcpServers"])).toBe(four);
  });

  test("creates the file's whole shape when there is no file yet", () => {
    const after = setOwnedField("", ["mcpServers", "red-skills"], { command: "bun" });
    expect(after).toBe(`{\n  "mcpServers": {\n    "red-skills": {\n      "command": "bun"\n    }\n  }\n}\n`);
  });

  test("overwrites our own previous value without moving its neighbours", () => {
    const first = setOwnedField(USER, ["mcpServers", "red-skills"], OURS);
    const second = setOwnedField(first, ["mcpServers", "red-skills"], { command: "node" });

    expect(readOwnedField(second, ["mcpServers", "red-skills"])).toEqual({ command: "node" });
    expect(second).toContain(`      "args": ["/home/someone/tools/server.mjs"]\n`);
    expect(dropOwnedField(second, ["mcpServers", "red-skills"])).toBe(USER);
  });

  test("refuses a document it cannot read rather than repairing it", () => {
    // A comment, a trailing comma, a half-finished edit. Splicing into
    // text we do not understand is how a config the host still loads
    // becomes one it does not.
    expect(() => setOwnedField(`{ "a": 1, }`, ["b"], 2)).toThrow();
    expect(() => setOwnedField(`// mine\n{}`, ["b"], 2)).toThrow();
  });

  test("refuses a pointer that would bury somebody else's value", () => {
    expect(() => setOwnedField(`{"mcpServers": 3}`, ["mcpServers", "red-skills"], OURS)).toThrow();
  });
});

describe("removing a field we own", () => {
  test("takes its separator with it, from the middle of an object", () => {
    const after = dropOwnedField(USER, ["mcpServers"]);
    expect(after).toBe(`{\n  "theme": "GitHub Dark",\n  "autoAccept": false\n}\n`);
  });

  test("takes the comma before it, from the end of an object", () => {
    const after = dropOwnedField(USER, ["autoAccept"]);
    expect(after).toBe(`{\n  "theme": "GitHub Dark",\n  "mcpServers": {\n    "their-own": {\n      "command": "node",\n      "args": ["/home/someone/tools/server.mjs"]\n    }\n  }\n}\n`);
  });

  test("collapses the object when what we owned was all it held", () => {
    const only = `{\n  "mcpServers": {\n    "red-skills": { "command": "bun" }\n  }\n}\n`;
    expect(dropOwnedField(only, ["mcpServers", "red-skills"])).toBe(`{\n  "mcpServers": {}\n}\n`);
  });

  test("removes the parent we created, and only while it stays empty", () => {
    // The two halves of the same question. A `mcpServers` block that
    // exists to hold our one entry should go when the entry does; one
    // the operator has since put a server of their own into must not.
    const made = setOwnedField("", ["mcpServers", "red-skills"], OURS);
    const emptied = dropOwnedField(made, ["mcpServers", "red-skills"]);
    expect(dropOwnedField(emptied, ["mcpServers"], { onlyWhenEmpty: true })).toBe(`{}\n`);

    const shared = dropOwnedField(
      setOwnedField(made, ["mcpServers", "theirs"], { command: "node" }),
      ["mcpServers", "red-skills"],
    );
    expect(dropOwnedField(shared, ["mcpServers"], { onlyWhenEmpty: true })).toBe(shared);
    expect(readOwnedField(shared, ["mcpServers", "theirs"])).toEqual({ command: "node" });
  });

  test("a field that is not there leaves the file exactly as it was", () => {
    expect(dropOwnedField(USER, ["mcpServers", "red-skills"])).toBe(USER);
    expect(dropOwnedField(USER, ["nothing", "here"])).toBe(USER);
    expect(dropOwnedField("", ["a"])).toBe("");
  });

  test("a file we cannot read is handed back untouched", () => {
    const broken = `{ "a": 1, }`;
    expect(dropOwnedField(broken, ["a"])).toBe(broken);
  });
});

describe("reading a field we own", () => {
  test("answers undefined for every kind of absence", () => {
    expect(readOwnedField(USER, ["mcpServers", "red-skills"])).toBeUndefined();
    expect(readOwnedField(USER, ["theme", "nested"])).toBeUndefined();
    expect(readOwnedField(`{`, ["theme"])).toBeUndefined();
  });

  test("and the value itself when it is there", () => {
    expect(readOwnedField(USER, ["theme"])).toBe("GitHub Dark");
    expect(readOwnedField(USER, ["autoAccept"])).toBe(false);
  });
});
