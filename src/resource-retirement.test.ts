import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resourceRetirementPlan, retireCargoInclude, retireResourceControls, retireWslResources, retireLegacyRc, retireLegacyZellij } from "./resource-retirement.ts";
import { applyRetirement, planRetirement } from "./managed-retirements.ts";
import type { Platform } from "./platform.ts";

const roots: string[] = [];
const home = () => { const root = mkdtempSync(join(tmpdir(), "red-dev-retirement-")); roots.push(root); return root; };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const put = (root: string, path: string, content: string) => { const full = join(root, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, content); return full; };
const slice = "[Unit]\nDescription=red-dev interactive pane workloads\nDocumentation=https://github.com/reddb-io/red-dev\n[Slice]\nMemoryMax=3G\nCPUQuota=200%\nTasksMax=2048\n";
const cargo = '# red-dev:build-resources begin\n# managed include\ninclude = ["../.config/red-dev/cargo.toml"]\n# red-dev:build-resources end\n';
const platform: Platform = { os: "linux", distro: "ubuntu", version: "26.04", codename: null, env: "desktop", arch: "x64", caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false } };
const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, timedOut: false, groupGone: true });

describe("retired resource controls", () => {
  test("fresh machines install no policy and run no systemd commands", async () => {
    const root = home();
    const result = await retireResourceControls(platform, { home: root, run: async () => { throw Error("fresh installation reached systemd"); } });
    expect(result.retired).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test("archives old quotas and wrappers while preserving unrelated Cargo settings, then is idempotent", async () => {
    const root = home();
    const user = '\n[build]\ntarget-dir="/local/artifacts"\njobs=7\n';
    const quota = put(root, ".config/systemd/user/red-dev-heavy-panes.slice", slice);
    const cfg = put(root, ".cargo/config.toml", cargo + user);
    const wrapper = put(root, ".local/share/red-dev/config/bash/build-resources.sh", "# Managed by red-dev. Generated from the Workload Policy.\nexec systemd-run --property=MemoryMax=3G bash\n");
    const result = await retireResourceControls({ ...platform, caps: { ...platform.caps, systemd: false } }, { home: root });
    expect(result.retired.sort()).toEqual([quota, cfg, wrapper].sort());
    expect(readFileSync(cfg, "utf8")).toBe(user);
    expect(existsSync(quota)).toBe(false);
    const backups = join(root, ".local/state/red-dev/retired-resource-controls");
    const copies = readdirSync(backups);
    expect(copies).toHaveLength(3);
    expect(copies.map(name => readFileSync(join(backups, name), "utf8"))).toContain(slice);
    for (const name of copies) expect(lstatSync(join(backups, name)).mode & 0o777).toBe(0o600);
    expect((await retireResourceControls(platform, { home: root, run: async () => { throw Error("clean machine reached systemd"); } })).retired).toEqual([]);
  });

  test("preserves files of other owners and symlinks, even at old managed paths", () => {
    const root = home();
    const foreign = put(root, ".config/red-dev/cargo.toml", "# mine\n[build]\njobs=3\n");
    const target = put(root, "user-shell", "# Managed by red-dev.\nprivate contents\n");
    const shell = join(root, ".local/share/red-dev/config/bash/build-resources.sh");
    mkdirSync(dirname(shell), { recursive: true }); symlinkSync(target, shell);
    const plan = resourceRetirementPlan(root);
    expect(plan.changes).toEqual([]);
    expect(plan.preserved.sort()).toEqual([foreign, shell].sort());
    expect(readFileSync(target, "utf8")).toContain("private contents");
  });

  test("repairs the old Zellij reader before deleting the adapter and preserves custom shell content", () => {
    const root = home();
    const rc = '# Entry point sourced from ~/.bashrc:\nfor _red_part in path shared build-resources zellij; do\necho custom\ndone\n';
    const zellij = '# Zellij as the session, not as a command you remember to type.\nif declare -F _red_dev_run_control >/dev/null 2>&1; then\n  _red_zellij_launch() { _red_dev_run_control zellij "$@"; }\nelse\n  echo "refusing uncontained zellij"\nfi\necho custom\n';
    const zPath = put(root, ".local/share/red-dev/config/bash/zellij.sh", zellij);
    const rcPath = put(root, ".local/share/red-dev/config/bash/rc.sh", rc);
    const wrapper = put(root, ".local/share/red-dev/config/bash/build-resources.sh", "# Managed by red-dev.\n");
    const plan = resourceRetirementPlan(root);
    expect(plan.changes.map(change => change.path)).toEqual([zPath, rcPath, wrapper]);
    applyRetirement(plan, join(root, "backups"));
    expect(readFileSync(rcPath, "utf8")).toContain("path shared zellij");
    expect(readFileSync(zPath, "utf8")).toContain('_red_zellij_launch() { zellij "$@"; }');
    expect(readFileSync(zPath, "utf8")).toContain("echo custom");
    expect(retireLegacyRc(readFileSync(rcPath, "utf8"))).toBeUndefined();
    expect(retireLegacyZellij(readFileSync(zPath, "utf8"))).toBeUndefined();
  });

  test("retiring Cargo preserves CRLF/BOM and refuses mixed or malformed managed blocks", () => {
    const source = '\ufeff' + cargo.replaceAll('\n', '\r\n') + '[net]\r\ngit-fetch-with-cli=true\r\n';
    expect(retireCargoInclude(source)).toBe('\ufeff[net]\r\ngit-fetch-with-cli=true\r\n');
    expect(retireCargoInclude(cargo.replace('include =', 'jobs=3\ninclude ='))).toBeUndefined();
    expect(retireCargoInclude(cargo.replace('# red-dev:build-resources end', '# missing end'))).toBeUndefined();
    expect(retireCargoInclude(cargo.replace('["../.config/red-dev/cargo.toml"]', '[{path="../.config/red-dev/cargo.toml", optional=true}]'))).toBe("");
  });

  test("WSL cleanup removes marked rows and preserves unmarked user budgets and networking", () => {
    const source = '[wsl2]\r\nmemory=24GB\r\n# Added by red-dev; unrelated operator values are preserved.\r\nprocessors=6\r\nswap=4GB\r\nnetworkingMode=mirrored\r\n[experimental]\r\n# Added by red-dev; existing operator values are never replaced.\r\nautoMemoryReclaim=dropCache\r\n';
    expect(retireWslResources(source)).toBe('[wsl2]\r\nmemory=24GB\r\nnetworkingMode=mirrored\r\n[experimental]\r\n');
    expect(retireWslResources('[wsl2]\nmemory=8GB\n')).toBeUndefined();
  });

  test("stops the guardian before thaw/reset, releases live quotas and keeps service-owner limits", async () => {
    const root = home();
    put(root, ".config/systemd/user/red-dev.slice", slice);
    put(root, ".config/systemd/user/red-dev-heavy-builds.slice", slice);
    put(root, ".config/systemd/user/red-dev-disk-guardian.timer", "# Managed by red-dev.\n[Timer]\nOnUnitActiveSec=10s\n");
    const drop = put(root, ".config/systemd/user/red-worker-.service.d/50-red-dev-heavy-slice.conf", "# Managed by red-dev.\n[Service]\nSlice=red-dev-heavy-agents.slice\nMemoryMax=3G\nCPUQuota=200%\n");
    const native = put(root, ".config/systemd/user/red-worker-live.service", "[Service]\nMemoryMax=5G\n");
    const fleet = put(root, ".config/systemd/user/red-fleet-.scope.d/50-red-dev-heavy-slice.conf", "# Managed by red-dev.\n[Scope]\nSlice=red-dev-heavy-builds.slice\nCPUWeight=50\n");
    const calls: string[][] = [];
    await retireResourceControls(platform, { home: root, run: async argv => {
      calls.push(argv);
      if (argv.includes("list-units")) return ok(JSON.stringify(["red-dev.slice", "red-dev-heavy-builds.slice", "run-a12.scope", "run-b34.scope", "red-worker-live.service", "red-fleet-live.scope", "other.service"].map(unit => ({ unit }))));
      if (argv.includes("show")) return ok(`ControlGroup=/user/${argv[3] === "run-b34.scope" ? "app.slice" : "red-dev.slice"}/${argv[3]}\nFragmentPath=${native}\nDropInPaths=${argv[3] === "red-worker-live.service" ? drop : argv[3] === "red-fleet-live.scope" ? fleet : ""}\n`);
      return ok();
    } });
    expect(calls.findIndex(argv => argv.includes("disable"))).toBeLessThan(calls.findIndex(argv => argv.includes("thaw")));
    const reset = calls.filter(argv => argv.includes("set-property"));
    expect(reset.find(argv => argv.includes("run-a12.scope"))).toContain("MemoryMax=infinity");
    expect(reset.find(argv => argv.includes("run-a12.scope"))).toContain("CPUQuota=");
    expect(reset.some(argv => argv.includes("run-b34.scope"))).toBe(false);
    expect(reset.find(argv => argv.includes("red-worker-live.service"))).toContain("MemoryMax=5G");
    expect(reset.find(argv => argv.includes("red-worker-live.service"))).not.toContain("TasksMax=infinity");
    expect(reset.find(argv => argv.includes("red-fleet-live.scope"))).toContain("CPUWeight=100");
    expect(reset.find(argv => argv.includes("red-fleet-live.scope"))).not.toContain("MemoryMax=infinity");
    expect(calls.some(argv => argv.includes("restart") || argv.includes("kill"))).toBe(false);
    expect(calls.at(-1)).toEqual(["systemctl", "--user", "daemon-reload"]);
  });

  test("a failed live release keeps definitions available for a retry", async () => {
    const root = home();
    const path = put(root, ".config/systemd/user/red-dev.slice", slice);
    await expect(retireResourceControls(platform, { home: root, run: async argv => argv.includes("list-units") ? { ...ok(), exitCode: 1 } : ok() })).rejects.toThrow("could not release");
    expect(readFileSync(path, "utf8")).toBe(slice);
    expect(resourceRetirementPlan(root).changes).toHaveLength(1);
  });

  test("refuses a changed retirement input and preserves its latest contents", () => {
    const root = home();
    const path = put(root, "old-file", "owned");
    const plan = planRetirement([{ path, retire: () => null }]);
    writeFileSync(path, "new user contents");
    expect(() => applyRetirement(plan, join(root, "backups"))).toThrow("input changed");
    expect(readFileSync(path, "utf8")).toBe("new user contents");
  });

  test("retries a failed systemd reload even after all old files are gone", async () => {
    const root = home();
    const path = put(root, ".config/systemd/user/red-dev.slice", slice);
    await expect(retireResourceControls(platform, { home: root, run: async argv =>
      argv.includes("list-units") ? ok("[]") : { ...ok(), exitCode: 1 },
    })).rejects.toThrow("reload failed");
    expect(existsSync(path)).toBe(false);
    const calls: string[][] = [];
    await retireResourceControls(platform, { home: root, run: async argv => { calls.push(argv); return ok(); } });
    expect(calls).toEqual([["systemctl", "--user", "daemon-reload"]]);
    expect(existsSync(join(root, ".local/state/red-dev/retired-resource-controls/pending-reload"))).toBe(false);
  });
});
