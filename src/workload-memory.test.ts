import { expect, test } from "bun:test";
import { releaseWorkloadMemoryLimits } from "./workload-memory.ts";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, timedOut: false, groupGone: true });

test("releases old memory caps on owned live scopes without touching other groups", async () => {
  const changed: string[] = [];
  const result = await releaseWorkloadMemoryLimits(async (argv) => {
    if (argv.includes("list-units")) return ok(JSON.stringify([
      { unit: "red-dev.slice" }, { unit: "run-rabc.scope" },
      { unit: "run-rdef.scope" }, { unit: "app.slice" },
      { unit: "redskilled.service" },
    ]));
    if (argv.includes("show")) {
      const unit = argv[3];
      const group = unit === "run-rdef.scope" ? "/user/app.slice/run-rdef.scope" : `/user/red-dev.slice/${unit}`;
      return ok(`ControlGroup=${group}\nMemoryMax=2147483648\nMemoryHigh=infinity\nMemorySwapMax=0\n`);
    }
    expect(argv.slice(0, 4)).toEqual(["systemctl", "--user", "set-property", "--runtime"]);
    expect(argv.slice(-3)).toEqual(["MemoryHigh=infinity", "MemoryMax=infinity", "MemorySwapMax=infinity"]);
    changed.push(argv[4]!);
    return ok();
  });
  expect(result).toEqual({ released: ["red-dev.slice", "run-rabc.scope"], failed: [] });
  expect(changed).toEqual(result.released);
});

test("does not reapply unlimited settings and reports a denied repair", async () => {
  const result = await releaseWorkloadMemoryLimits(async (argv) => {
    if (argv.includes("list-units")) return ok('[{"unit":"red-dev.slice"},{"unit":"run-rabc.scope"}]');
    if (argv.includes("show")) return ok(`ControlGroup=/user/red-dev.slice/${argv[3]}\nMemoryHigh=infinity\nMemoryMax=${argv[3] === "red-dev.slice" ? "infinity" : "1024"}\nMemorySwapMax=infinity\n`);
    expect(argv[4]).toBe("run-rabc.scope");
    return { ...ok(), exitCode: 1 };
  });
  expect(result).toEqual({ released: [], failed: ["run-rabc.scope"] });
});
