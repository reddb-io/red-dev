/** Explicit choices. Provisioning never creates or enforces resource restrictions. */
export interface ResourceSettings {
  mode: "system" | "responsive" | "custom";
  wsl?: { memoryGiB: number; swapGiB: number };
  buildSlots?: number;
}
export function parseResourceSettings(value: unknown): ResourceSettings {
  const v = value as ResourceSettings;
  if (!v || typeof v !== "object" || !["system", "responsive", "custom"].includes(v.mode)) throw Error("invalid resource choice");
  if (v.mode === "system" && (v.wsl !== undefined || v.buildSlots !== undefined)) throw Error("system resources cannot carry restrictions");
  if (v.buildSlots !== undefined && (!Number.isSafeInteger(v.buildSlots) || v.buildSlots < 1 || v.buildSlots > 64)) throw Error("build slots must be between 1 and 64");
  if (v.wsl !== undefined && (!v.wsl || !Number.isSafeInteger(v.wsl.memoryGiB) || v.wsl.memoryGiB < 1 || v.wsl.memoryGiB > 1024 || !Number.isSafeInteger(v.wsl.swapGiB) || v.wsl.swapGiB < 0 || v.wsl.swapGiB > 1024)) throw Error("WSL memory must be 1..1024 GiB and swap 0..1024 GiB");
  if (v.mode !== "system" && !v.wsl && v.buildSlots === undefined) throw Error("choose WSL memory or build slots explicitly");
  return v;
}
export function suggestedWslMemory(totalBytes: number | null): number | null {
  if (totalBytes === null) return null;
  const total = Math.floor(totalBytes / 1024 ** 3);
  return total >= 8 ? Math.max(1, Math.floor(total * 0.75)) : null;
}
