import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  convergeRouterAutostart,
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  LEGACY_ROUTER_SERVICE,
  ROUTER_SERVICE,
  routerEnabled,
  routerHost,
  routerPort,
  routerServiceNeedsRestart,
  routerWrapper,
} from "./red-router.ts";
import type { Platform } from "./platform.ts";

const SYSTEMD: Platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "desktop",
  arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: false },
};

describe("RedRouter service contract", () => {
  test("uses the official package defaults and service name", () => {
    expect(ROUTER_SERVICE).toBe("red-router.service");
    expect(LEGACY_ROUTER_SERVICE).toBe("red-dev-9router.service");
    expect(routerPort({})).toBe(DEFAULT_ROUTER_PORT);
    expect(routerHost({})).toBe(DEFAULT_ROUTER_HOST);
    expect(routerPort({ RED_ROUTER_PORT: "26000" })).toBe(26000);
    expect(routerHost({ RED_ROUTER_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(routerEnabled({ RED_ROUTER: "0" })).toBe(false);
  });

  test("Windows starts the official command in tray mode", () => {
    expect(routerWrapper("C:\\mise.exe", 25050, "127.0.0.1")).toContain(
      '"C:\\mise.exe" exec red-router -- red-router -t --skip-update -n -p 25050 -H "127.0.0.1"',
    );
  });

  test("restarts a live service only when its generated definition moved", () => {
    expect(routerServiceNeedsRestart("old", "new", true)).toBe(true);
    expect(routerServiceNeedsRestart("same", "same", true)).toBe(false);
    expect(routerServiceNeedsRestart(null, "new", false)).toBe(false);
    expect(routerServiceNeedsRestart("old", null, true)).toBe(false);
  });

  test("the postinstall reloads a live router after its installer repoints the unit", async () => {
    const home = mkdtempSync(join(tmpdir(), "red-router-postinstall-"));
    const unit = join(home, ".config/systemd/user/red-router.service");
    mkdirSync(join(home, ".config/systemd/user"), { recursive: true });
    writeFileSync(unit, "ExecStart=/old/red-router\n");
    const calls: string[][] = [];

    const outcome = await convergeRouterAutostart(SYSTEMD, {
      home,
      routerBinary: "/fixture/red-router",
      miseBinary: null,
      run: async (argv) => {
        calls.push(argv);
        if (argv.join(" ") === "systemctl --user is-active red-router.service") return { exitCode: 0 };
        if (argv[0] === "/fixture/red-router") writeFileSync(unit, "ExecStart=/new/red-router\n");
        return { exitCode: argv.includes("is-enabled") ? 1 : 0 };
      },
    });

    expect(outcome).toBe("installed");
    expect(calls).toContainEqual(["systemctl", "--user", "restart", "red-router.service"]);
  });
});
