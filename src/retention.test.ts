import { describe, expect, test } from "bun:test";
import { selectRetention, type RetainedFile } from "./retention.ts";

const DAY = 24 * 60 * 60 * 1_000;
const now = Date.parse("2026-08-11T15:00:00.000Z");
const file = (name: string, ageDays: number, size: number): RetainedFile => ({
  path: `/state/${name}`,
  name,
  size,
  mtimeMs: now - ageDays * DAY,
});

describe("derived artifact retention", () => {
  test("TTL, count and byte budgets remove oldest unprotected files first", () => {
    const files = [
      file("active.log", 40, 80),
      file("expired.log", 31, 10),
      file("old.log", 10, 80),
      file("new.log", 1, 80),
    ];

    const selected = selectRetention(
      files,
      { maxCount: 3, maxAgeMs: 30 * DAY, maxBytes: 160 },
      now,
      new Set(["/state/active.log"]),
    );

    expect(selected.map((item) => [item.file.name, item.reasons])).toEqual([
      ["expired.log", ["older than TTL"]],
      ["old.log", ["over byte budget"]],
    ]);
  });
});
