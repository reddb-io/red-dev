import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { FILES } from "./dotfiles.ts";
import type { Platform } from "./platform.ts";
import { workloadPolicy } from "./workload-policy.ts";

const LINUX_SYSTEMD: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};
const WORKSTATION = { totalMemoryBytes: 20 * 1024 ** 3, logicalCpus: 10, hostDiskGuardian: true };

describe("workload policy", () => {
  test("package managers run directly and old owned wrappers are retired", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-package-direct-`);
    try {
      const shell = `${dir}/workload.sh`;
      writeFileSync(shell, workloadPolicy(WORKSTATION).shell);
      const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-c", `
        npm() { _red_dev_run_build npm "$@"; }
        pnpm() { _red_dev_run_build pnpm "$@"; }
        bun() { printf 'USER FUNCTION'; }
        source "${shell}"
        declare -F npm pnpm >/dev/null && exit 7
        bun
      `], { env: { ...process.env, ZELLIJ: "", RED_ENV: "server" }, stdout: "pipe", stderr: "pipe" });
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stdout).text()).toBe("USER FUNCTION");
      expect(await new Response(proc.stderr).text()).toBe("");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("keeps Zellij protected while every ordinary pane enters the bounded work plane", async () => {
    const policy = workloadPolicy(WORKSTATION);

    expect(policy.systemd["red-dev-interactive.slice"]).toContain("MemoryLow=2G");
    expect(policy.systemd["red-dev-heavy-panes.slice"]).toContain("MemoryMax=infinity");
    const paneLaunch = policy.launch("pane", ["bash"], LINUX_SYSTEMD);
    expect(paneLaunch.slice(0, 6)).toEqual([
      "systemd-run", "--user", "--scope", "--quiet", "--collect",
      "--slice=red-dev-heavy-panes.slice",
    ]);
    expect(paneLaunch).toContain("--property=MemoryMax=infinity");
    expect(paneLaunch.some((arg) => arg === "--property=MemoryHigh=infinity")).toBe(true);
    expect(paneLaunch.slice(-3)).toEqual(["red-dev-heavy-panes.slice", "pane", "bash"]);
    expect(paneLaunch[paneLaunch.indexOf("-c") + 1]).toContain("cat /proc/self/cgroup");
    if (process.platform === "win32") return;

    const dir = mkdtempSync(`${tmpdir()}/red-dev-workload-policy-`);
    const runtime = `${dir}/run`;
    const bin = `${dir}/bin`;
    mkdirSync(`${runtime}/systemd`, { recursive: true });
    mkdirSync(bin);
    const manager = Bun.listen({
      unix: `${runtime}/systemd/private`,
      socket: { data() {} },
    });
    try {
      const systemdRun = `${bin}/systemd-run`;
      writeFileSync(systemdRun, '#!/bin/sh\nprintf "SCOPE %s\\n" "$*"\nexit 73\n');
      chmodSync(systemdRun, 0o755);
      const shell = `${dir}/workload.sh`;
      writeFileSync(shell, policy.shell);
      const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-c", `source "${shell}"; echo CONTINUED`], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RED_ENV: "wsl",
          ZELLIJ: "0",
          RED_DEV_PANE_SCOPED: "",
          XDG_RUNTIME_DIR: runtime,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(73);
      expect(stdout).toContain("--slice=red-dev-heavy-panes.slice");
      expect(stdout).toContain("red-dev-workload-guard red-dev-heavy-panes.slice pane bash");
      expect(stdout).not.toContain("CONTINUED");
      expect(stderr).toContain("pane resource guard failed");
    } finally {
      manager.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("routes agents and builds through the same aggregate work budget", () => {
    const policy = workloadPolicy(WORKSTATION);

    expect(policy.systemd["red-dev-heavy-agents.slice"]).toContain("MemoryMax=infinity");
    expect(policy.systemd["red-dev-heavy-builds.slice"]).toContain("CPUWeight=50");
    const agentLaunch = policy.launch("agent", ["redcode", "--yolo"], LINUX_SYSTEMD);
    expect(agentLaunch).toContain("--slice=red-dev-heavy-agents.slice");
    expect(agentLaunch).toContain("--property=MemoryMax=infinity");
    expect(agentLaunch.some((arg) => arg === "--property=MemoryHigh=infinity")).toBe(true);
    expect(agentLaunch.slice(-4)).toEqual([
      "red-dev-heavy-agents.slice", "agent", "redcode", "--yolo",
    ]);
    const buildLaunch = policy.launch("build", ["cargo", "test"], LINUX_SYSTEMD);
    expect(buildLaunch).toContain("--slice=red-dev-heavy-builds.slice");
    expect(buildLaunch).toContain("--property=MemoryMax=infinity");
    expect(buildLaunch.some((arg) => arg === "--property=MemoryHigh=infinity")).toBe(true);
    expect(buildLaunch.slice(-7)).toEqual([
      "red-dev-heavy-builds.slice", "build", "nice", "-n", "10", "cargo", "test",
    ]);
  });

  test("scales CPU scheduling without imposing memory caps", () => {
    const small = workloadPolicy({ totalMemoryBytes: 20 * 1024 ** 3, logicalCpus: 10 });
    expect(small.systemd["red-dev.slice"]).toContain("MemoryMax=infinity");
    expect(small.systemd["red-dev.slice"]).toContain("CPUQuota=800%");
    expect(small.systemd["red-dev-heavy.slice"]).toContain("MemoryMax=infinity");
    expect(small.launch("pane", ["bash"], LINUX_SYSTEMD)).toContain(
      "--property=MemoryMax=infinity",
    );

    const large = workloadPolicy({ totalMemoryBytes: 40 * 1024 ** 3, logicalCpus: 20 });
    expect(large.systemd["red-dev.slice"]).toContain("MemoryMax=infinity");
    expect(large.systemd["red-dev.slice"]).toContain("CPUQuota=1600%");
    expect(large.launch("agent", ["redcode"], LINUX_SYSTEMD)).toContain(
      "--property=MemoryMax=infinity",
    );
    expect(large.launch("build", ["cargo"], LINUX_SYSTEMD)).toContain(
      "--property=MemoryMax=infinity",
    );
  });

  test("removes reclaim throttles, hard limits and swap bans from every managed domain", () => {
    for (const swapTotalBytes of [0, 2 * 1024 ** 3, 24 * 1024 ** 3]) {
      const policy = workloadPolicy({ totalMemoryBytes: 16 * 1024 ** 3, logicalCpus: 8, swapTotalBytes });
      for (const [unit, content] of Object.entries(policy.systemd)) {
        if (!unit.endsWith(".slice")) continue;
        for (const property of ["MemoryHigh", "MemoryMax", "MemorySwapMax"]) {
          expect(content).toContain(`${property}=infinity`);
        }
      }
    }
  });

  test("attaches the control daemon and every Worker to the generated domains", () => {
    const policy = workloadPolicy(WORKSTATION);

    expect(policy.systemd["redskilled.service.d/50-red-dev-heavy-slice.conf"]).toBe(
      "# Managed by red-dev.\n[Service]\nSlice=red-dev-interactive.slice\n",
    );
    expect(policy.systemd["red-worker-.service.d/50-red-dev-heavy-slice.conf"]).toContain(
      "Slice=red-dev-heavy-agents.slice\nMemoryHigh=infinity\nCPUQuota=250%",
    );
    expect(policy.systemd["red-worker-.service.d/50-red-dev-heavy-slice.conf"]).toContain(
      "MemoryMax=infinity",
    );
    expect(policy.systemd["red-worker-.service.d/50-red-dev-heavy-slice.conf"]).toContain(
      "MemoryHigh=infinity",
    );
    expect(policy.systemd["red-fleet-.scope.d/50-red-dev-heavy-slice.conf"]).toBe(
      "# Managed by red-dev.\n[Scope]\nSlice=red-dev-heavy-agents.slice\n",
    );
  });

  test("freezes only agent and build domains when the Windows host disk reaches the critical floor", async () => {
    if (process.platform === "win32") return;
    const policy = workloadPolicy(WORKSTATION);
    const dir = mkdtempSync(`${tmpdir()}/red-dev-disk-guardian-`);
    const bin = `${dir}/bin`;
    const calls = `${dir}/systemctl.calls`;
    mkdirSync(bin);
    try {
      writeFileSync(
        `${bin}/df`,
        "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'C: 1000000000 985000000 15000000 99%% /mnt/c\\n'\n",
      );
      writeFileSync(
        `${bin}/systemctl`,
        `#!/bin/sh\nprintf '%s\\n' "$*" >>"${calls}"\n`,
      );
      chmodSync(`${bin}/df`, 0o755);
      chmodSync(`${bin}/systemctl`, 0o755);
      const guardian = `${dir}/disk-guardian.sh`;
      writeFileSync(guardian, policy.diskGuardian ?? "");

      const proc = Bun.spawn(["/bin/sh", guardian], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          XDG_STATE_HOME: `${dir}/state`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      const invocation = await Bun.file(calls).text();
      expect(invocation).toContain(
        "--user freeze red-dev-heavy-builds.slice red-dev-heavy-agents.slice",
      );
      expect(invocation).not.toContain("freeze red-dev-heavy.slice");
      expect(await Bun.file(`${dir}/state/red-dev/disk-guardian-last`).text()).toContain(
        "action=frozen reason=host-disk-critical",
      );
      expect(await Bun.file(`${dir}/state/red-dev/workloads.log`).text()).toContain(
        "kind=disk-guardian result=frozen reason=host-disk-critical",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("freezes fail closed when the Windows host disk cannot be measured", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-disk-guardian-unknown-`);
    const bin = `${dir}/bin`;
    const calls = `${dir}/systemctl.calls`;
    mkdirSync(bin);
    try {
      writeFileSync(`${bin}/df`, "#!/bin/sh\nexit 1\n");
      writeFileSync(`${bin}/systemctl`, `#!/bin/sh\nprintf '%s\\n' "$*" >>"${calls}"\n`);
      chmodSync(`${bin}/df`, 0o755);
      chmodSync(`${bin}/systemctl`, 0o755);
      const guardian = `${dir}/disk-guardian.sh`;
      writeFileSync(guardian, workloadPolicy(WORKSTATION).diskGuardian ?? "");

      const proc = Bun.spawn(["/bin/sh", guardian], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          XDG_STATE_HOME: `${dir}/state`,
        },
      });
      expect(await proc.exited).toBe(0);
      expect(await Bun.file(calls).text()).toContain(
        "--user freeze red-dev-heavy-builds.slice red-dev-heavy-agents.slice",
      );
      expect(await Bun.file(`${dir}/state/red-dev/disk-guardian-frozen`).text()).toContain(
        "reason=host-disk-unavailable",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("returns 125 instead of claiming success when cgroups cannot be frozen", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-disk-guardian-freeze-failure-`);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    try {
      writeFileSync(
        `${bin}/df`,
        "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'C: 1000000000 985000000 15000000 99%% /mnt/c\\n'\n",
      );
      writeFileSync(`${bin}/systemctl`, "#!/bin/sh\nexit 1\n");
      chmodSync(`${bin}/df`, 0o755);
      chmodSync(`${bin}/systemctl`, 0o755);
      const guardian = `${dir}/disk-guardian.sh`;
      writeFileSync(guardian, workloadPolicy(WORKSTATION).diskGuardian ?? "");

      const proc = Bun.spawn(["/bin/sh", guardian], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          XDG_STATE_HOME: `${dir}/state`,
        },
      });
      expect(await proc.exited).toBe(125);
      expect(await Bun.file(`${dir}/state/red-dev/disk-guardian-frozen`).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("thaws guarded workloads after the Windows host disk recovers", async () => {
    if (process.platform === "win32") return;
    const policy = workloadPolicy(WORKSTATION);
    const dir = mkdtempSync(`${tmpdir()}/red-dev-disk-guardian-recovery-`);
    const bin = `${dir}/bin`;
    const state = `${dir}/state/red-dev`;
    const calls = `${dir}/systemctl.calls`;
    mkdirSync(bin, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(`${state}/disk-guardian-frozen`, "frozen\n");
    try {
      writeFileSync(
        `${bin}/df`,
        "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'C: 1000000000 900000000 100000000 90%% /mnt/c\\n'\n",
      );
      writeFileSync(
        `${bin}/systemctl`,
        `#!/bin/sh\nprintf '%s\\n' "$*" >>"${calls}"\n`,
      );
      chmodSync(`${bin}/df`, 0o755);
      chmodSync(`${bin}/systemctl`, 0o755);
      const guardian = `${dir}/disk-guardian.sh`;
      writeFileSync(guardian, policy.diskGuardian ?? "");

      const proc = Bun.spawn(["/bin/sh", guardian], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          XDG_STATE_HOME: `${dir}/state`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(await Bun.file(calls).exists()).toBe(true);
      expect(await Bun.file(calls).text()).toContain(
        "--user thaw red-dev-heavy-builds.slice red-dev-heavy-agents.slice",
      );
      expect(await Bun.file(`${state}/disk-guardian-frozen`).exists()).toBe(false);
      expect(await Bun.file(`${state}/disk-guardian-last`).text()).toContain(
        "action=thawed reason=host-disk-recovered",
      );
      expect(await Bun.file(`${state}/workloads.log`).text()).toContain(
        "kind=disk-guardian result=thawed reason=host-disk-recovered",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("installs shell launchers from that same policy", async () => {
    if (process.platform === "win32") return;
    const policy = workloadPolicy(WORKSTATION);
    const dir = mkdtempSync(`${tmpdir()}/red-dev-workload-shell-`);
    const runtime = `${dir}/run`;
    const bin = `${dir}/bin`;
    mkdirSync(`${runtime}/systemd`, { recursive: true });
    mkdirSync(bin);
    const manager = Bun.listen({
      unix: `${runtime}/systemd/private`,
      socket: { data() {} },
    });
    try {
      for (const command of ["cargo", "redcode"]) {
        writeFileSync(`${bin}/${command}`, "#!/bin/sh\nexit 0\n");
        chmodSync(`${bin}/${command}`, 0o755);
      }
      writeFileSync(
        `${bin}/df`,
        "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'C: 1000000000 800000000 200000000 80%% /mnt/c\\n'\n",
      );
      chmodSync(`${bin}/df`, 0o755);
      writeFileSync(`${bin}/systemd-run`, '#!/bin/sh\nprintf "SCOPE %s\\n" "$*"\n');
      chmodSync(`${bin}/systemd-run`, 0o755);
      const shell = `${dir}/workload.sh`;
      writeFileSync(shell, policy.shell);
      const proc = Bun.spawn([
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        `source "${shell}"; redcode ask; cargo test`,
      ], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RED_ENV: "wsl",
          ZELLIJ: "",
          XDG_RUNTIME_DIR: runtime,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("--slice=red-dev-heavy-agents.slice");
      expect(stdout).toContain("--property=MemoryMax=infinity --property=MemorySwapMax=infinity");
      expect(stdout).toContain("red-dev-heavy-agents.slice agent redcode ask");
      expect(stdout).toContain("--slice=red-dev-heavy-builds.slice");
      expect(stdout).toContain("--property=MemoryMax=infinity --property=MemorySwapMax=infinity");
      expect(stdout).toContain("red-dev-heavy-builds.slice build nice -n 10 cargo test");
    } finally {
      manager.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a mise-managed agent's own `update` becomes `red-dev agents update`", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-agent-update-`);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    try {
      // The vendor updater must never run: it would install a second
      // copy that the mise shim shadows.
      writeFileSync(`${bin}/claude`, '#!/bin/sh\nprintf "VENDOR %s\\n" "$*"\n');
      writeFileSync(`${bin}/red-dev`, '#!/bin/sh\nprintf "RED-DEV %s\\n" "$*"\n');
      for (const command of ["claude", "red-dev"]) chmodSync(`${bin}/${command}`, 0o755);
      const shell = `${dir}/workload.sh`;
      writeFileSync(shell, workloadPolicy(WORKSTATION).shell);
      const run = async (script: string) => {
        const proc = Bun.spawn(["bash", "--noprofile", "--norc", "-c", `source "${shell}"; ${script}`], {
          env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RED_ENV: "windows", ZELLIJ: "" },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [stdout, stderr] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        return { stdout, stderr };
      };

      const update = await run("claude update");
      expect(update.stdout).toBe("RED-DEV agents update\n");
      expect(update.stderr).toContain("kept current by mise");

      // Anything else, including `update` with more to say, is the
      // vendor's own business and passes through untouched.
      expect((await run("claude --version")).stdout).toBe("VENDOR --version\n");
      expect((await run("claude update --check")).stdout).toBe("VENDOR update --check\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("preserves spaces and glob characters in wrapped command arguments", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-workload-argv-`);
    const bin = `${dir}/bin`;
    mkdirSync(bin);
    writeFileSync(`${bin}/cargo`, '#!/bin/sh\nprintf "ARG=<%s>\\n" "$@"\n');
    chmodSync(`${bin}/cargo`, 0o755);
    const shell = `${dir}/workload.sh`;
    writeFileSync(shell, workloadPolicy(WORKSTATION).shell);
    try {
      const proc = Bun.spawn([
        "bash",
        "--noprofile",
        "--norc",
        "-c",
        `source "${shell}"; cargo "two words" "*.ts"`,
      ], {
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}`, RED_ENV: "windows" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exit).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toBe("ARG=<two words>\nARG=<*.ts>\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses a WSL build before the Windows host disk crosses its reserve", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-workload-disk-`);
    const runtime = `${dir}/run`;
    const bin = `${dir}/bin`;
    const marker = `${dir}/executed`;
    mkdirSync(`${runtime}/systemd`, { recursive: true });
    mkdirSync(bin);
    const manager = Bun.listen({
      unix: `${runtime}/systemd/private`,
      socket: { data() {} },
    });
    try {
      writeFileSync(
        `${bin}/df`,
        "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'C: 1000000000 970000000 30000000 97%% /mnt/c\\n'\n",
      );
      writeFileSync(`${bin}/cargo`, `#!/bin/sh\ntouch "${marker}"\n`);
      writeFileSync(
        `${bin}/systemd-run`,
        '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
      );
      for (const command of ["df", "cargo", "systemd-run"]) {
        chmodSync(`${bin}/${command}`, 0o755);
      }
      const shell = `${dir}/workload.sh`;
      writeFileSync(shell, workloadPolicy(WORKSTATION).shell);

      const proc = Bun.spawn([
        "/bin/bash", "--noprofile", "--norc", "-c", `source "${shell}"; cargo test`,
      ], {
        env: {
          ...process.env,
          HOME: dir,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RED_ENV: "wsl",
          XDG_RUNTIME_DIR: runtime,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(125);
      expect(await new Response(proc.stderr).text()).toContain(
        "Windows host disk reserve",
      );
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      manager.stop(true);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("admits a WSL build with 34 GiB free while preserving the 30 GiB reserve", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-workload-disk-admit-`);
    const bin = `${dir}/bin`;
    const marker = `${dir}/executed`;
    mkdirSync(bin);
    try {
      writeFileSync(
        `${bin}/df`,
        "#!/bin/sh\nprintf 'Filesystem 1024-blocks Used Available Capacity Mounted on\\n'\nprintf 'C: 1000000000 964000000 36000000 97%% /mnt/c\\n'\n",
      );
      writeFileSync(`${bin}/cargo`, `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(`${bin}/df`, 0o755);
      chmodSync(`${bin}/cargo`, 0o755);
      const shell = `${dir}/workload.sh`;
      writeFileSync(shell, workloadPolicy(WORKSTATION).shell);

      const proc = Bun.spawn([
        "/bin/bash", "--noprofile", "--norc", "-c", `source "${shell}"; cargo test`,
      ], {
        env: {
          ...process.env,
          HOME: dir,
          PATH: `${bin}:${process.env.PATH ?? ""}`,
          RED_ENV: "wsl",
          RED_DEV_HEAVY_SCOPE: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await proc.exited).toBe(0);
      expect(await new Response(proc.stderr).text()).toBe("");
      expect(await Bun.file(marker).exists()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses Linux workloads when containment is unavailable or cannot be proven", async () => {
    if (process.platform === "win32") return;
    const dir = mkdtempSync(`${tmpdir()}/red-dev-workload-refusal-`);
    const runtime = `${dir}/run`;
    const bin = `${dir}/bin`;
    const state = `${dir}/state`;
    mkdirSync(`${runtime}/systemd`, { recursive: true });
    mkdirSync(bin);
    const marker = `${dir}/executed`;
    const shell = `${dir}/workload.sh`;
    writeFileSync(shell, workloadPolicy(WORKSTATION).shell);
    writeFileSync(`${bin}/cargo`, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(`${bin}/cargo`, 0o755);

    try {
      const unavailable = Bun.spawn([
        "/bin/bash", "--noprofile", "--norc", "-c", `source "${shell}"; cargo test`,
      ], {
        env: {
          HOME: dir,
          PATH: bin,
          RED_ENV: "server",
          XDG_RUNTIME_DIR: `${dir}/missing`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(await unavailable.exited).toBe(125);
      expect(await new Response(unavailable.stderr).text()).toContain(
        "refusing uncontained build workload",
      );
      expect(await Bun.file(marker).exists()).toBe(false);

      const manager = Bun.listen({
        unix: `${runtime}/systemd/private`,
        socket: { data() {} },
      });
      try {
        writeFileSync(
          `${bin}/systemd-run`,
          '#!/bin/sh\nwhile [ "$1" != "--" ]; do shift; done\nshift\nexec "$@"\n',
        );
        writeFileSync(
          `${bin}/cat`,
          "#!/bin/sh\nprintf '0::/red-dev-heavy-agents.slice/test.scope\\n'\n",
        );
        chmodSync(`${bin}/systemd-run`, 0o755);
        chmodSync(`${bin}/cat`, 0o755);
        const wrongGroup = Bun.spawn([
          "/bin/bash", "--noprofile", "--norc", "-c", `source "${shell}"; cargo test`,
        ], {
          env: {
            ...process.env,
            HOME: dir,
            PATH: `${bin}:${process.env.PATH ?? ""}`,
            RED_ENV: "server",
            XDG_RUNTIME_DIR: runtime,
            XDG_STATE_HOME: state,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(await wrongGroup.exited).toBe(125);
        expect(await new Response(wrongGroup.stderr).text()).toContain(
          "entered the wrong cgroup",
        );
        expect(await Bun.file(marker).exists()).toBe(false);
        expect(await Bun.file(`${state}/red-dev/workloads.log`).text()).toContain(
          "result=refused",
        );
      } finally {
        manager.stop(true);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("deploys the policy before Zellij and uses it to launch the protected server", () => {
    const policy = workloadPolicy();

    expect(FILES["build-resources.sh"]).toBe(policy.shell);
    expect(FILES["rc.sh"]).toContain(
      "for _red_part in path shared build-resources zellij",
    );
    expect(FILES["rc.sh"]).toContain(
      "for _red_part in init aliases functions prompt red-skills-watch",
    );
    expect(FILES["zellij.sh"]).toContain("_red_dev_run_control zellij");
    expect(FILES["zellij.sh"]).toContain("refusing uncontained zellij");
    expect(FILES["zellij.sh"]).not.toContain("--slice=red-dev-interactive.slice");
    // No Windows host disk unless the caller says so: the guardian reads
    // a missing /mnt/c as a critical one and freezes agents and builds.
    expect(policy.diskGuardian).toBeNull();
    expect(policy.systemd["red-dev-disk-guardian.timer"]).toBeUndefined();
    const wsl = workloadPolicy(WORKSTATION);
    expect(wsl.diskGuardian).toContain("systemctl --user freeze");
    expect(wsl.systemd["red-dev-disk-guardian.timer"]).toContain("OnUnitActiveSec=10s");
    expect(wsl.systemd["red-dev-disk-guardian.service"]).toContain(
      "Slice=red-dev-interactive.slice",
    );
  });
});
