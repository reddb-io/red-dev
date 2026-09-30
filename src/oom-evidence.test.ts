import { expect, test } from "bun:test";
import { journalEvidence } from "./linux-host.ts";

test("historical victim, memory group and service come only from journal evidence", () => {
  const evidence = journalEvidence("2026-09-30T12:00:00+00:00 host kernel: Out of memory: Killed process 1234 (node) task_memcg=/user.slice/red-dev.slice/red-worker-one.service\n", "kernel");
  expect(evidence.oomIncidents).toEqual([{ at: "2026-09-30T12:00:00.000Z", pid: 1234, command: "node", cgroup: "/user.slice/red-dev.slice/red-worker-one.service", unit: "red-worker-one.service", source: "kernel" }]);
  const summary = journalEvidence("2026-09-30T12:01:00+00:00 host systemd: red-dev-build.slice: A process was killed by the OOM killer");
  expect(summary.oomIncidents[0]?.pid).toBeNull();
  expect(summary.oomIncidents[0]?.command).toBeNull();
  expect(journalEvidence("invalid-time host kernel: Out of memory: Killed process 1234 (node)").oomIncidents).toEqual([]);
});
