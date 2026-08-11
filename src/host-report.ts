import { assessHost, type HostSnapshot } from "./host-health.ts";
import type { StatuslineHealth } from "./statusline-health.ts";

export interface HostReportRow {
  kind: "ok" | "warning" | "error" | "skip";
  name: string;
  detail: string;
  fix?: string;
}

export interface HostReport {
  problems: number;
  rows: HostReportRow[];
}

export function buildHostReport(
  snapshot: HostSnapshot,
  statusline: StatuslineHealth,
): HostReport {
  const assessment = assessHost(snapshot);
  const rows: HostReportRow[] = assessment.findings.map((finding) => ({
    kind: finding.level === "critical" ? "error" : "warning",
    name: finding.id,
    detail: finding.detail,
    fix: finding.id === "orphan-groups" ? "red-dev rescue" : undefined,
  }));

  if (statusline.legacyConfig) {
    rows.push({
      kind: "error",
      name: "statusline config",
      detail: "legacy multi-producer recipe can strand shells and Node",
      fix: "replace it with the single-producer bounded recipe",
    });
  }
  if (statusline.groupGone === false) {
    rows.push({
      kind: "error",
      name: "statusline lifecycle",
      detail: "producer left descendants behind after its deadline",
      fix: "red-dev update after the RedSkills lifecycle release",
    });
  } else if (statusline.bounded === false) {
    rows.push({
      kind: "error",
      name: "statusline lifecycle",
      detail: "bundle did not exit while stdin remained open; its group was cleaned up",
      fix: "red-dev update after the RedSkills lifecycle release",
    });
  } else if (statusline.bounded === true) {
    rows.push({ kind: "ok", name: "statusline lifecycle", detail: "bounded with stdin open" });
  } else if (statusline.bundle === null) {
    rows.push({ kind: "skip", name: "statusline lifecycle", detail: "RedSkills bundle not installed" });
  }

  return {
    problems: rows.filter((row) => row.kind === "warning" || row.kind === "error").length,
    rows,
  };
}
