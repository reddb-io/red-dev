import { expect, test } from "bun:test";
import { doctorRepair } from "./doctor-repair.ts";
import { captureTo } from "./log.ts";
import type { Platform } from "./platform.ts";
const linux: Platform = { os: "linux", distro: "ubuntu", version: "26.04", codename: "resolute", env: "desktop", arch: "x64", caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true } };

test("preview does not execute repairs; apply reaches only the selected repair", async () => {
  const lines: string[] = []; const restore = captureTo(line => lines.push(line));
  const calls: string[] = [];
  try {
    expect(await doctorRepair(linux, "mise-auth", false, async repair => { calls.push(repair); return 0; })).toBe(0);
    expect(calls).toEqual([]);
    expect(lines.join("\n")).toContain("--repair mise-auth --apply");
    expect(await doctorRepair(linux, "mise-auth", true, async repair => { calls.push(repair); return 1; })).toBe(1);
    expect(calls).toEqual(["mise-auth"]);
  } finally { restore(); }
});
