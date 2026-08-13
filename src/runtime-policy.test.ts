import { describe, expect, test } from "bun:test";
import {
  isKnownRuntimeId,
  resolveRuntimeIds,
  runtimeIdsForPolicy,
  runtimeInstallRequest,
} from "./runtimes.ts";

describe("runtime version policy", () => {
  test("can move every offered runtime to its newest release", () => {
    expect(
      runtimeIdsForPolicy(
        ["node@lts", "python@3.13", "rust@stable", "bun@latest"],
        "latest",
      ),
    ).toEqual(["node@latest", "python@latest", "rust@latest", "bun@latest"]);
  });

  test("leaves the compatibility-tested selectors intact by default", () => {
    expect(runtimeIdsForPolicy(["node@lts", "python@3.13"], "recommended")).toEqual([
      "node@lts",
      "python@3.13",
    ]);
  });

  test("accepts latest and exact versions for known names only", () => {
    expect(isKnownRuntimeId("node@latest")).toBe(true);
    expect(isKnownRuntimeId("python@3.14.1")).toBe(true);
    expect(isKnownRuntimeId("unknown@latest")).toBe(false);
    expect(isKnownRuntimeId("node@latest;touch-nope")).toBe(false);
  });

  test("makes bare CLI runtime names valid when --latest supplies the selector", () => {
    expect(resolveRuntimeIds(["node", "python@3.13"], "latest")).toEqual({
      ids: ["node@latest", "python@latest"],
      unknown: [],
    });
    expect(resolveRuntimeIds(["unknown", "node;touch-nope"], "latest").unknown).toEqual([
      "unknown@latest",
      "node;touch-nope@latest",
    ]);
  });

  test("never silently compiles a latest Python without its expected libraries", () => {
    expect(runtimeInstallRequest("python@latest")).toEqual({
      id: "python@latest",
      env: { MISE_PYTHON_COMPILE: "0" },
    });
  });
});
