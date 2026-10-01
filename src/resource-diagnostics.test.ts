import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectLinuxResources, resourceSnapshot, resourceReport, WINDOWS_RESOURCE_SCRIPT } from "./resource-diagnostics.ts";
import { runBounded } from "./bounded-command.ts";
import type { Platform } from "./platform.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function root() { const r = mkdtempSync(join(tmpdir(), "resource-observation-")); roots.push(r); return r; }
function put(r: string, path: string, value: string) { const p = join(r, path); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, value); }
const windows: Platform = { os: "windows", env: "windows", arch: "x64", distro: null, version: null, codename: null,
  caps: { apt: false, gui: true, systemd: false, winget: true, flatpak: false } };
const reply = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", timedOut: false, groupGone: true });

test("Linux diagnosis exposes VM memory, swap pressure and an inherited 3 GiB ceiling", () => {
  const r = root(); const proc = join(r, "proc"), cg = join(r, "cgroup");
  put(proc, "meminfo", "MemTotal: 16777216 kB\nMemAvailable: 1000000 kB\nSwapTotal: 4194304 kB\nSwapFree: 1000000 kB\n");
  put(proc, "pressure/memory", "some avg10=12.50 avg60=2.00 total=10\nfull avg10=8.25 avg60=1.00 total=8\n");
  put(proc, "vmstat", "pswpin 27\npswpout 89\n");
  put(proc, "22/comm", "rustc\n"); put(proc, "22/status", "VmRSS: 2000000 kB\n");
  put(proc, "22/cgroup", "0::/red-dev.slice/run-abc.scope\n"); put(proc, "11/cgroup", "0::/red-dev.slice/run-abc.scope\n");
  put(cg, "red-dev.slice/memory.max", "3221225472\n"); put(cg, "red-dev.slice/memory.events", "oom_kill 2\n");
  put(cg, "memory.max", "max\n");
  const report = inspectLinuxResources(proc, cg, 11);
  expect(report.memory.total).toBe(16 * 1024 ** 3);
  expect(report.pressure.fullAvg10).toBe(8.25); expect(report.swapCounters.pagesOut).toBe(89);
  expect(report.builds[0]?.rss).toBe(2000000 * 1024);
  expect(report.cgroups).toContainEqual({ path: "/red-dev.slice", max: "3221225472", high: null, swapMax: null, oomKills: 2 });
});
test("Windows host RAM is observed independently; a stopped WSL is never started", async () => {
  const r = root(); const calls: string[][] = [];
  const snapshot = await resourceSnapshot(windows, { home: r, run: async argv => {
    calls.push(argv);
    if (argv.includes(WINDOWS_RESOURCE_SCRIPT)) return reply(JSON.stringify({ total: 32 * 1024 ** 3, available: 10 * 1024 ** 3, path: join(r, ".wslconfig"), content: Buffer.from("[wsl2]\nmemory=16GB\nswap=4GB\n").toString("base64") }));
    return reply("");
  } });
  expect(snapshot.windows?.total).toBe(32 * 1024 ** 3);
  expect(snapshot.wsl.memory).toBe("16GB"); expect(snapshot.linux).toBeNull();
  expect(calls.filter(a => a[0] === "wsl.exe")).toEqual([["wsl.exe", "--list", "--running", "--quiet"]]);
  expect(snapshot.unknown.join(" ")).toContain("Linux telemetry unavailable");
});
test("missing Windows telemetry stays unknown and never uses Linux VM RAM as host RAM", async () => {
  const r = root(); const snapshot = await resourceSnapshot({ ...windows, os: "linux", env: "wsl" }, {
    home: r, procRoot: r, cgroupRoot: r, run: async () => { throw Error("interop unavailable"); },
  });
  expect(snapshot.windows).toBeNull(); expect(snapshot.wsl.path).toBeNull();
  expect(resourceReport(snapshot).join("\n")).toContain("no host budget inferred from Linux memory");
});
test("a running selected WSL returns separate telemetry without starting other distros", async () => {
  const r = root(); const calls: string[][] = [];
  const linux = inspectLinuxResources(r, r);
  const snapshot = await resourceSnapshot({ ...windows, wslDistro: "Ubuntu-开发" }, { home: r, run: async argv => {
    calls.push(argv);
    if (argv.includes(WINDOWS_RESOURCE_SCRIPT)) return reply(JSON.stringify({ total: 32 * 1024 ** 3, available: 8 * 1024 ** 3, path: join(r, ".wslconfig"), content: null }));
    if (argv.includes("--running")) return reply("Ubuntu-开发\nOther\n");
    return reply(JSON.stringify({ schema: 1, linux, legacy: [] }));
  } });
  expect(snapshot.wsl.runningDistro).toBe("Ubuntu-开发"); expect(snapshot.linux).toEqual(linux);
  expect(calls.at(-1)?.slice(0, 5)).toEqual(["wsl.exe", "--distribution", "Ubuntu-开发", "--exec", "sh"]);
});
test("bounded Windows output preserves non-ASCII UTF-16LE distro names", async () => {
  const result = await runBounded([process.execPath, "-e", 'process.stdout.write(Buffer.from("Ubuntu-开发\\n", "utf16le"))'], { windowsOutput: true });
  expect(result.stdout).toBe("Ubuntu-开发\n"); expect(result.exitCode).toBe(0);
});
test.skipIf(process.platform !== "win32")("the real Windows PowerShell host probe returns physical RAM", async () => {
  const result = await runBounded(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_RESOURCE_SCRIPT], { timeoutMs: 15000 });
  expect([result.exitCode, result.timedOut]).toEqual([0, false]);
  const host = JSON.parse(result.stdout);
  expect(host.total).toBeGreaterThan(0); expect(host.available).toBeGreaterThanOrEqual(0);
  expect(host.path).toContain(".wslconfig");
}, 20000);
