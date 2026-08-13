/**
 * Sudo authentication belongs before the fullscreen renderer owns stdin.
 *
 * Inside the TUI every provider deliberately uses `sudo -n`: an unexpected
 * password prompt must fail rather than become an invisible hang. The human
 * install path therefore warms the credential once, visibly, before render.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Platform } from "./platform.ts";
import { primeSudoInteractive, sudoItemsFor } from "./sudo-preflight.ts";

const ubuntu: Platform = {
  os: "linux",
  env: "desktop",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};

describe("the sudo preflight plan", () => {
  test("a fresh Ubuntu install names archive and deb-installer work", () => {
    const names = sudoItemsFor(ubuntu, ["core", "desktop"], () => "absent");

    expect(names).toContain("btop");
    expect(names).toContain("carapace");
    expect(names).toContain("red-request");
    expect(names).toContain("dit");
  });

  test("a converged machine and native Windows ask for nothing", () => {
    expect(sudoItemsFor(ubuntu, ["core", "desktop"], () => "ok")).toEqual([]);
    expect(
      sudoItemsFor(
        { ...ubuntu, os: "windows", env: "windows", caps: { ...ubuntu.caps, apt: false } },
        ["core", "desktop"],
        () => "absent",
      ),
    ).toEqual([]);
  });
});

describe("visible sudo authentication", () => {
  test("uses sudo -v with the terminal attached exactly once", async () => {
    const calls: string[][] = [];
    const ok = await primeSudoInteractive({
      uid: () => 1000,
      run: async (argv) => {
        calls.push(argv);
        return 0;
      },
    });

    expect(ok).toBe(true);
    expect(calls).toEqual([["sudo", "-v"]]);
  });

  test("root needs no sudo process", async () => {
    let ran = false;
    expect(
      await primeSudoInteractive({ uid: () => 0, run: async () => ((ran = true), 0) }),
    ).toBe(true);
    expect(ran).toBe(false);
  });
});

describe("the human install entry points", () => {
  test("the bootstrap marks its launch and direct install primes before rendering", () => {
    const boot = readFileSync(`${import.meta.dir}/../boot.sh`, "utf8");
    const main = readFileSync(`${import.meta.dir}/main.ts`, "utf8");

    expect(boot).toContain("export RED_DEV_BOOTSTRAP=1");
    // `curl | sh` leaves stdin pointing at the exhausted script pipe. The
    // downloaded binary must inherit the controlling terminal or neither
    // its sudo prompt nor its fullscreen interface can read a key.
    expect(boot).toContain('exec "$BIN" < /dev/tty');
    expect(boot.indexOf("export RED_DEV_BOOTSTRAP=1")).toBeLessThan(
      boot.indexOf('exec "$BIN" < /dev/tty'),
    );

    // The bootstrap enters the menu rather than `cmdInstall`, so it needs
    // the same visible preflight before the first fullscreen frame.
    expect(main).toContain('process.env["RED_DEV_BOOTSTRAP"] === "1"');
    expect(main.indexOf('process.env["RED_DEV_BOOTSTRAP"] === "1"')).toBeLessThan(
      main.indexOf("const { runTui }"),
    );
    expect(main.indexOf("await prepareSudo(p, scopes)")).toBeLessThan(
      main.indexOf("await runInstallTui("),
    );
  });
});
