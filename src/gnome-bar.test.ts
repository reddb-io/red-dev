import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  convergeGnomeBar, GNOME_BAR_FILES, GNOME_BAR_REVISION, GNOME_BAR_UUID,
  gnomeBarActorDrift, gnomeBarDir, gnomeBarDrift, inspectGnomeBar, parseGnomeExtensionInfo,
  type GnomeBarRunner,
} from "./gnome-bar.ts";
import type { Platform } from "./platform.ts";

const desktop: Platform = {
  os: "linux", distro: "ubuntu", version: "24.04", codename: "noble", env: "desktop", arch: "x64",
  caps: { apt: true, gui: true, systemd: true, winget: false, flatpak: true },
};
const tempHomes: string[] = [];
afterEach(() => { for (const dir of tempHomes.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function info(state: number | null, error = ""): string {
  return JSON.stringify({ type: "a{sv}", data: [state === null ? {} : {
    uuid: { type: "s", data: GNOME_BAR_UUID }, state: { type: "d", data: state }, error: { type: "s", data: error },
  }] });
}

/** All session commands are fakes; these tests never touch the live desktop. */
function fixture() {
  const homeDir = mkdtempSync(join(tmpdir(), "red-dev-gnome-bar-test-"));
  tempHomes.push(homeDir);
  const calls: string[][] = [];
  const session = {
    state: 1 as number | null, revision: GNOME_BAR_REVISION as string | null,
    selected: ["someone-elses@example.org", GNOME_BAR_UUID], usersDisabled: false,
    available: true, error: "", enableCode: 0, becomesActive: true, settingsFail: false, settingsIgnoreWrites: false,
  };
  const ok = (out = "") => ({ code: 0, out, err: "" });
  const run: GnomeBarRunner = async (argv) => {
    calls.push([...argv]);
    if (argv[0] === "gsettings") {
      const key = argv[3];
      if (session.settingsFail) return { code: 1, out: "", err: "settings are read-only" };
      if (argv[1] === "get") return ok(key === "enabled-extensions" ? JSON.stringify(session.selected) : String(session.usersDisabled));
      if (session.settingsIgnoreWrites) return ok();
      if (key === "enabled-extensions") session.selected = [...(argv[4] ?? "").matchAll(/'([^']+)'/g)].map(match => match[1]!);
      else session.usersDisabled = argv[4] === "true";
      return ok();
    }
    if (!session.available) return { code: 1, out: "", err: "No GNOME session" };
    if (argv.includes("GetExtensionInfo")) return ok(info(session.state, session.error));
    if (argv.includes("Get")) return session.revision === null
      ? { code: 1, out: "", err: "UnknownObject" }
      : ok(JSON.stringify({ type: "s", data: [JSON.stringify({ revision: session.revision, menu: { visible: true, mapped: true, width: 70, height: 30 }, indicators: [] })] }));
    if (argv.includes("EnableExtension")) {
      if (session.enableCode !== 0) return { code: session.enableCode, out: "", err: "Shell refused enable" };
      if (session.becomesActive) session.state = 1;
      return ok(JSON.stringify({ type: "b", data: [true] }));
    }
    throw new Error(`Unexpected session command: ${argv.join(" ")}`);
  };
  const options = { homeDir, run, quiet: true };
  const install = async () => {
    mkdirSync(gnomeBarDir(homeDir), { recursive: true });
    for (const [name, body] of Object.entries(GNOME_BAR_FILES)) await Bun.write(join(gnomeBarDir(homeDir), name), body);
  };
  return { homeDir, calls, session, options, install };
}

describe("GNOME numeric runtime state", () => {
  test("reads ACTIVE=1 from machine JSON, independent of translated CLI text", () => {
    expect(parseGnomeExtensionInfo(info(1))).toEqual({ state: 1, error: "", known: true });
    expect(parseGnomeExtensionInfo(info(3, "bad import"))).toEqual({ state: 3, error: "bad import", known: true });
    expect(parseGnomeExtensionInfo(info(null))).toEqual({ state: null, error: "", known: false });
    expect(parseGnomeExtensionInfo("State: ACTIVE")).toBeNull();
    expect(parseGnomeExtensionInfo('{"type":"a{sv}","data":[null]}')).toBeNull();
  });

  test("embeds the content revision, not an independently maintained version", () => {
    expect(GNOME_BAR_REVISION).toMatch(/^[0-9a-f]{64}$/);
    expect(GNOME_BAR_FILES["extension.js"]).toContain(GNOME_BAR_REVISION);
    expect(GNOME_BAR_FILES["extension.js"]).not.toContain("__RED_DEV_BAR_REVISION__");
  });

  test("a current file hash alone cannot establish the loaded revision", async () => {
    const f = fixture();
    await f.install();
    f.session.revision = null;
    const status = await inspectGnomeBar(desktop, f.options);
    expect(status.filesCurrent).toBe(true);
    expect(status.active).toBe(true);
    expect(status.state).toBe("pending-login");
    expect(gnomeBarDrift(status).status).toBe("drift");
    expect(gnomeBarDrift(status).fix).toContain("sign out");
  });

  test("matching revision plus active numeric state establishes running, not visual appearance", async () => {
    const f = fixture();
    await f.install();
    const status = await inspectGnomeBar(desktop, f.options);
    expect(status.state).toBe("active");
    expect(status.runtimeRevision).toBe(GNOME_BAR_REVISION);
    expect(status.detail).toContain("visual appearance is not verified");
    expect(gnomeBarDrift(status)).toMatchObject({ status: "ok" });
    expect(f.calls.filter(argv => argv[0] === "busctl").every(argv => argv.includes("--timeout=3"))).toBe(true);
    expect(f.calls.every(argv => !argv.includes("set") && !argv.includes("EnableExtension"))).toBe(true);
  });

  test("missing files, stale files and missing session have separate outcomes", async () => {
    const f = fixture();
    expect((await inspectGnomeBar(desktop, f.options)).state).toBe("missing");
    await f.install();
    await Bun.write(join(gnomeBarDir(f.homeDir), "stylesheet.css"), "stale");
    expect((await inspectGnomeBar(desktop, f.options)).state).toBe("outdated");
    await f.install();
    f.session.available = false;
    const status = await inspectGnomeBar(desktop, f.options);
    expect(status.state).toBe("unavailable");
    expect(status.active).toBe(false);
    expect(status.fix).toContain("signed-in GNOME session");
  });

  test("selected does not hide user-extension disablement or Shell errors", async () => {
    const f = fixture();
    await f.install();
    f.session.usersDisabled = true;
    expect((await inspectGnomeBar(desktop, f.options)).state).toBe("disabled");
    f.session.usersDisabled = false;
    f.session.state = 3;
    f.session.error = "extension import failed";
    const status = await inspectGnomeBar(desktop, f.options);
    expect(status.state).toBe("error");
    expect(status.detail).toContain("extension import failed");
  });

  test("a selected but inactive extension points to reconcile, not a forced login", async () => {
    const f = fixture();
    await f.install();
    f.session.state = 2;
    f.session.revision = null;
    const status = await inspectGnomeBar(desktop, f.options);
    expect(status.state).toBe("disabled");
    expect(status.fix).toBe("red-dev desktop reconcile");
  });
});

describe("GNOME actor observations", () => {
  const mapped = { visible: true, mapped: true, width: 80, height: 24 };

  test("checks the menu and exact mapped labels, not the advertised D-Bus titles", async () => {
    const f = fixture();
    await f.install();
    const status = await inspectGnomeBar(desktop, f.options);
    status.runtime = {
      revision: GNOME_BAR_REVISION, menu: mapped,
      indicators: ["RedRouter", "Redskilled"].map(name => ({ name, registered: true, actors: [{ indicator: mapped, label: { ...mapped, text: name } }] })),
    };
    expect(gnomeBarActorDrift(status).map(check => check.status)).toEqual(["ok", "ok", "ok"]);
    expect(gnomeBarActorDrift(status).every(check => check.detail.includes("visual appearance is not verified"))).toBe(true);

    status.runtime.indicators = [
      { name: "RedRouter", registered: true, actors: [{ indicator: mapped, label: { ...mapped, text: "RedRouter", width: 0 } }] },
      { name: "Redskilled", registered: true, actors: [{ indicator: mapped, label: { ...mapped, text: "wrong" } }] },
    ];
    expect(gnomeBarActorDrift(status).map(check => check.status)).toEqual(["ok", "drift", "drift"]);
  });

  test("unknown labels do not become ok; absent indicators do not imply stopped services", async () => {
    const f = fixture();
    await f.install();
    const status = await inspectGnomeBar(desktop, f.options);
    status.runtime = { revision: GNOME_BAR_REVISION, menu: { ...mapped, mapped: false }, indicators: [{ name: "RedRouter", registered: false }] };
    const checks = gnomeBarActorDrift(status);
    expect(checks.map(check => check.status)).toEqual(["drift", "n/a", "drift"]);
    expect(checks[1]?.detail).toContain("service state is not inferred");
  });

  test("a hidden duplicate helper cannot be hidden by one correctly mapped helper", async () => {
    const f = fixture();
    await f.install();
    const status = await inspectGnomeBar(desktop, f.options);
    status.runtime = { revision: GNOME_BAR_REVISION, menu: mapped, indicators: [{ name: "RedRouter", registered: true, actors: [
      { indicator: mapped, label: { ...mapped, text: "RedRouter" } },
      { indicator: mapped, label: { ...mapped, text: "RedRouter", mapped: false } },
    ] }] };
    expect(gnomeBarActorDrift(status)[1]?.status).toBe("drift");
  });

  test("old runtime revision reports its lifecycle problem only", async () => {
    const f = fixture();
    await f.install();
    f.session.revision = "old";
    expect(gnomeBarActorDrift(await inspectGnomeBar(desktop, f.options))).toEqual([]);
  });
});

describe("GNOME convergence", () => {
  test("updates files without toggling an active cached module, even on repeat", async () => {
    const f = fixture();
    f.session.revision = "old-revision";
    const first = await convergeGnomeBar(desktop, f.options);
    expect(first.changedFiles).toHaveLength(Object.keys(GNOME_BAR_FILES).length);
    expect(first.status.state).toBe("pending-login");
    expect(first.status.filesCurrent).toBe(true);
    const second = await convergeGnomeBar(desktop, f.options);
    expect(second.changedFiles).toEqual([]);
    expect(second.status.state).toBe("pending-login");
    expect(f.calls.some(argv => argv.includes("DisableExtension") || argv.includes("EnableExtension"))).toBe(false);
    expect(f.calls.some(argv => argv[0] === "gsettings" && argv[1] === "set")).toBe(false);
  });

  test("fresh installs retain unrelated extensions and defer unknown Shell registration until login", async () => {
    const f = fixture();
    f.session.state = null;
    f.session.revision = null;
    f.session.selected = ["someone-elses@example.org"];
    f.session.usersDisabled = true;
    const report = await convergeGnomeBar(desktop, f.options);
    expect(report.status.state).toBe("pending-login");
    expect(f.session.selected).toEqual(["someone-elses@example.org", GNOME_BAR_UUID]);
    expect(f.session.usersDisabled).toBe(false);
    expect(f.calls.some(argv => argv.includes("EnableExtension"))).toBe(false);
  });

  test("an inactive registered extension is enabled and then verified numerically", async () => {
    const f = fixture();
    f.session.state = 2;
    const report = await convergeGnomeBar(desktop, f.options);
    expect(report.status.state).toBe("active");
    expect(f.calls.filter(argv => argv.includes("EnableExtension"))).toHaveLength(1);
    const enableAt = f.calls.findIndex(argv => argv.includes("EnableExtension"));
    expect(f.calls.slice(enableAt + 1).some(argv => argv.includes("GetExtensionInfo"))).toBe(true);
  });

  test("an enable command succeeding is not proof of activation", async () => {
    const f = fixture();
    f.session.state = 2;
    f.session.becomesActive = false;
    await expect(convergeGnomeBar(desktop, f.options)).rejects.toThrow("did not become active");
  });

  test("reports rejected enables and configuration writes instead of logging success", async () => {
    const f = fixture();
    f.session.state = 2;
    f.session.enableCode = 1;
    await expect(convergeGnomeBar(desktop, f.options)).rejects.toThrow("Shell refused enable");
    f.session.settingsFail = true;
    await expect(convergeGnomeBar(desktop, f.options)).rejects.toThrow("settings are read-only");
  });

  test("a successful settings command must still leave the extension selected", async () => {
    const f = fixture();
    f.session.selected = ["someone-elses@example.org"];
    f.session.settingsIgnoreWrites = true;
    await expect(convergeGnomeBar(desktop, f.options)).rejects.toThrow("disabled in GNOME settings");
  });

  test("does not break mise postinstall for an installed extension outside a live desktop session", async () => {
    const f = fixture();
    f.session.available = false;
    const report = await convergeGnomeBar(desktop, f.options);
    expect(report.status.state).toBe("unavailable");
    expect(report.status.filesCurrent).toBe(true);
    expect(gnomeBarDrift(report.status).status).toBe("drift");
  });

  test("non-desktop platforms perform no session calls or file writes", async () => {
    const f = fixture();
    const report = await convergeGnomeBar({ ...desktop, env: "wsl" }, f.options);
    expect(report.status.state).toBe("not-applicable");
    expect(report.changedFiles).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(gnomeBarDrift(report.status).status).toBe("n/a");
  });
});
