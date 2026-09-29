import { describe, expect, test } from "bun:test";
import extensionSource from "../config/gnome/reddb-bar/extension.gnome" with { type: "text" };
import stylesheetSource from "../config/gnome/reddb-bar/stylesheet.gnome" with { type: "text" };

// Execute the shipped extension logic with actor doubles, rather than asserting
// that a label string appears in its source. This does not claim pixel-level
// validation in a running GNOME session.
class Actor {
  visible = true;
  width = 75;
  height = 24;
  text = "";
  style_class = "";
  parent: Actor | null = null;
  children: Actor[] = [];
  signals = new Map<number, { name: string; handler: (...args: unknown[]) => unknown }>();
  nextSignal = 1;
  destroyed = false;
  _indicator?: { label: string };
  _box?: Actor;
  _labelBin?: Actor;
  container: Actor = this;
  constructor(props: Record<string, unknown> = {}) { Object.assign(this, props); }
  get mapped(): boolean { return this.visible && (this.parent?.mapped ?? true); }
  add_child(child: Actor) { child.parent = this; this.children.push(child); }
  add_style_class_name(_name: string) {}
  remove_style_class_name(_name: string) {}
  get_children() { return [...this.children]; }
  set_text(text: string) { this.text = text; }
  get_text() { return this.text; }
  hide() { this.visible = false; }
  show() { this.visible = true; }
  connect(name: string, handler: (...args: unknown[]) => unknown) {
    const id = this.nextSignal++;
    this.signals.set(id, { name, handler });
    return id;
  }
  disconnect(id: number) { this.signals.delete(id); }
  destroy() {
    for (const signal of [...this.signals.values()]) {
      if (signal.name === "destroy") signal.handler();
    }
    for (const child of [...this.children]) child.destroy();
    if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this);
    this.parent = null;
    this.signals.clear();
    this.destroyed = true;
  }
}

class Menu {
  box = new Actor();
  items: Actor[] = [];
  openCount = 0;
  addMenuItem(item: Actor) { this.items.push(item); }
  removeAll() { this.items = []; }
  open() { this.openCount++; }
}

class MenuItem extends Actor {
  // PopupMenuItem exposes its St.Label as `label`; here the row is its own label.
  label: Actor = this;
  constructor(label: string) { super({ text: label }); }
}

class SubMenuItem extends MenuItem {
  menu = new Menu();
}

class Button extends Actor {
  menu = new Menu();
  constructor(...args: unknown[]) {
    super();
    this._init(...args);
  }
  _init(..._args: unknown[]) {}
}

interface TrayStatus {
  name: string;
  registered: boolean;
  actors: { label: { text: string; mapped: boolean }; indicator: { visible: boolean } }[];
}
interface Labels {
  status(): TrayStatus[];
  destroy(): void;
}
interface Bar {
  enable(): void;
  disable(): void;
}

function fixture(initial: Record<string, Actor> = {}) {
  const statusArea = { ...initial };
  const timers = new Map<number, () => boolean>();
  let nextTimer = 1;
  let exportedPath: string | null = null;
  let exportedInterface = "";
  let runtime: { Get: () => string } | null = null;
  const workspace = new Actor();
  const launched: string[][] = [];
  const notices: { kind: "notify" | "error"; title: string; body: string }[] = [];
  const dbusCalls: { method: string; args: unknown }[] = [];
  // Rows as ListUnitsByPatterns returns them: name, description, load, active, sub, ...
  let unitRows: string[][] = [];
  let failRestart = false;
  const files = new Map<string, string>();
  const disk = { free: 100 * 1024 ** 3, size: 600 * 1024 ** 3 };
  const Gio = {
    DBusCallFlags: { NONE: 0 },
    File: {
      new_for_path: () => {
        const file = {
          query_filesystem_info_async: (_attrs: string, _priority: number, _cancel: unknown,
            done: (file: unknown, result: unknown) => void) => done(file, {}),
          query_filesystem_info_finish: () => ({
            get_attribute_uint64: (name: string) => (name === "filesystem::free" ? disk.free : disk.size),
          }),
        };
        return file;
      },
    },
    SubprocessFlags: { STDOUT_PIPE: 1, STDERR_PIPE: 2 },
    Subprocess: { new: (argv: string[]) => { launched.push(argv); return { communicate_utf8_async: () => {} }; } },
    icon_new_for_string: (path: string) => path,
    DBus: {
      session: {
        call: (_name: string, _path: string, _iface: string, method: string, args: { value: unknown },
          _type: unknown, _flags: number, _timeout: number, _cancel: unknown,
          done: (connection: unknown, result: unknown) => void) => {
          dbusCalls.push({ method, args: args.value });
          done({
            call_finish: () => {
              if (method === "RestartUnit" && failRestart) throw new Error("Unit not found");
              return { deepUnpack: () => (method === "ListUnitsByPatterns" ? [unitRows] : []) };
            },
          }, {});
        },
      },
    },
    DBusExportedObject: {
      wrapJSObject: (xml: string, object: { Get: () => string }) => {
        exportedInterface = xml;
        runtime = object;
        return {
          export: (_connection: unknown, path: string) => { exportedPath = path; },
          unexport: () => { exportedPath = null; runtime = null; },
        };
      },
    },
  };
  const GLib = {
    Variant: class { constructor(public type: string, public value: unknown) {} },
    VariantType: class { constructor(public type: string) {} },
    PRIORITY_DEFAULT: 0,
    SOURCE_CONTINUE: true,
    timeout_add_seconds: (_priority: number, seconds: number, callback: () => boolean) => {
      expect(seconds).toBeGreaterThanOrEqual(1);
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    source_remove: (id: number) => timers.delete(id),
    get_home_dir: () => "/test",
    FileTest: { IS_EXECUTABLE: 1 },
    file_test: () => true,
    getenv: () => null,
    file_get_contents: (path: string) => (files.has(path)
      ? [true, new TextEncoder().encode(files.get(path))]
      : [false, new Uint8Array()]),
  };
  const source = extensionSource
    .replace(/^import .*;\n/gm, "")
    .replace("export default class RedDbBarExtension", "class RedDbBarExtension");
  const evaluate = new Function("Clutter", "Gio", "GLib", "GObject", "St", "Extension", "Main",
    "PanelMenu", "PopupMenu", "global", `${source}\nreturn {NamedTrayLabels, RedDbBarExtension};`);
  const classes = evaluate({ EVENT_PROPAGATE: false, EVENT_STOP: true }, Gio, GLib, { registerClass: (value: unknown) => value },
    { Label: Actor, Icon: Actor, BoxLayout: Actor }, class {},
    { notify: (title: string, body: string) => notices.push({ kind: "notify", title, body }),
      notifyError: (title: string, body: string) => notices.push({ kind: "error", title, body }),
      panel: {
      statusArea,
      add_style_class_name: () => {},
      remove_style_class_name: () => {},
      addToStatusArea: (id: string, actor: Actor) => { statusArea[id] = actor; },
    } },
    { Button }, { PopupImageMenuItem: MenuItem, PopupMenuItem: MenuItem, PopupSubMenuMenuItem: SubMenuItem, PopupSeparatorMenuItem: Actor },
    { workspace_manager: Object.assign(workspace, { n_workspaces: 0, get_active_workspace_index: () => 0 }) },
  ) as { NamedTrayLabels: new () => Labels; RedDbBarExtension: new () => Bar };
  return {
    ...classes, statusArea, timers, launched, notices, dbusCalls,
    setUnits: (rows: string[][]) => { unitRows = rows; },
    setFile: (path: string, text: string) => { files.set(path, text); },
    setDisk: (freeGiB: number, sizeGiB = 600) => { disk.free = freeGiB * 1024 ** 3; disk.size = sizeGiB * 1024 ** 3; },
    failRestarts: () => { failRestart = true; },
    tick: () => { for (const callback of timers.values()) callback(); },
    get exportedPath() { return exportedPath; },
    get exportedInterface() { return exportedInterface; },
    get runtime() { return runtime; },
  };
}

function indicator(name: string, visible = true) {
  const actor = new Actor({ visible });
  actor._indicator = { label: name };
  actor._box = new Actor();
  actor._labelBin = new Actor();
  actor.add_child(actor._box);
  actor._box.add_child(actor._labelBin);
  return actor;
}

describe("GNOME live named tray actors", () => {
  test("secondary click opens the red-dev and agent menus that own log actions", () => {
    const env = fixture();
    const bar = new env.RedDbBarExtension();
    bar.enable();
    const menus = [env.statusArea["reddb-menu"], env.statusArea["reddb-agents"]] as Button[];
    for (const button of menus) {
      const signal = [...button.signals.values()].find(value => value.name === "button-press-event");
      expect(signal).toBeDefined();
      expect(signal!.handler(button, { get_button: () => 1 })).toBe(false);
      expect(button.menu.openCount).toBe(0);
      expect(signal!.handler(button, { get_button: () => 3 })).toBe(true);
      expect(button.menu.openCount).toBe(1);
    }
    bar.disable();
  });

  test("the navbar brand keeps the RedDB mark, sized down from before", () => {
    expect(extensionSource).toContain("reddb-icon.svg");
    expect(extensionSource).not.toContain("BRAND_EMOJI");
    expect(stylesheetSource).toMatch(/\.reddb-brand-icon\s*\{[^}]*icon-size:\s*14px/s);
  });

  test("log menu actions use red-dev's read-only resolver without opening a terminal", () => {
    const env = fixture();
    const bar = new env.RedDbBarExtension();
    bar.enable();
    for (const label of ["Open red-dev log", "Open RedCode log"]) {
      const row = Object.values(env.statusArea).flatMap(actor => (actor as Button).menu?.items ?? []).find(item => item.text === label);
      expect(row).toBeDefined();
      for (const signal of row!.signals.values()) if (signal.name === "activate") signal.handler();
    }
    expect(env.launched.map(argv => argv.slice(1))).toEqual([
      ["logs", "--app", "red-dev", "--open"], ["logs", "--app", "redcode", "--open"],
    ]);
    bar.disable();
  });
  test("does not create service buttons for missing or unrelated indicators", () => {
    const unrelated = indicator("RedRouter preview");
    const env = fixture({ unrelated });
    const labels = new env.NamedTrayLabels();
    expect(labels.status()).toEqual([
      { name: "RedRouter", registered: false, actors: [] },
      { name: "Redskilled", registered: false, actors: [] },
    ]);
    expect(unrelated._box!.children).toEqual([unrelated._labelBin!]);
    labels.destroy();
  });

  test("adds names inside original buttons without replacing menus or actions", () => {
    const router = indicator("RedRouter");
    const skilled = indicator("Redskilled");
    const click = () => {};
    const clickId = router.connect("button-press-event", click);
    const env = fixture({ router, skilled });
    const labels = new env.NamedTrayLabels();
    env.tick();
    env.tick();
    expect(Object.keys(env.statusArea)).toEqual(["router", "skilled"]);
    expect(router.signals.get(clickId)?.handler).toBe(click);
    expect(router._labelBin!.visible).toBe(false);
    expect(router._box!.children.filter(child => child.style_class === "reddb-tray-name")).toHaveLength(1);
    expect(labels.status().map(row => row.actors[0]?.label.text)).toEqual(["RedRouter", "Redskilled"]);
    labels.destroy();
    expect(router._labelBin!.visible).toBe(true);
    expect(router._box!.children).toEqual([router._labelBin!]);
    expect(router.signals.size).toBe(1);
    expect(env.timers.size).toBe(0);
  });

  test("preserves passive visibility rather than inventing healthy-looking entries", () => {
    const router = indicator("RedRouter", false);
    const env = fixture({ router });
    const labels = new env.NamedTrayLabels();
    expect(labels.status()[0]?.actors[0]?.indicator.visible).toBe(false);
    expect(labels.status()[0]?.actors[0]?.label.mapped).toBe(false);
    labels.destroy();
  });

  test("handles native label replacement and restores its prior visibility on disable", () => {
    const router = indicator("RedRouter");
    const env = fixture({ router });
    const labels = new env.NamedTrayLabels();
    router._labelBin!.destroy();
    const next = new Actor({ visible: false });
    router._box!.add_child(next);
    router._labelBin = next;
    env.tick();
    labels.destroy();
    expect(next.visible).toBe(false);
    expect(next.signals.size).toBe(0);
  });

  test("tracks helper disappearance, restart and label identity changes", () => {
    const router = indicator("RedRouter");
    const env = fixture({ router });
    const labels = new env.NamedTrayLabels();
    router.destroy();
    delete env.statusArea.router;
    expect(labels.status()[0]?.registered).toBe(false);
    const replacement = indicator("RedRouter");
    env.statusArea.router = replacement;
    env.tick();
    expect(labels.status()[0]?.registered).toBe(true);
    replacement._indicator!.label = "Unrelated";
    env.tick();
    expect(labels.status()[0]?.registered).toBe(false);
    expect(replacement._labelBin!.visible).toBe(true);
    expect(replacement._box!.children).toEqual([replacement._labelBin!]);
    labels.destroy();
  });

  test("reports multiple actual helpers rather than hiding duplicate registrations", () => {
    const env = fixture({ first: indicator("RedRouter"), second: indicator("RedRouter") });
    const labels = new env.NamedTrayLabels();
    expect(labels.status()[0]?.actors).toHaveLength(2);
    labels.destroy();
  });

  test("exports only read-only runtime and actor status, then cleans it up", () => {
    const env = fixture({ router: indicator("RedRouter") });
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(env.exportedPath).toBe("/io/reddb/RedDevDesktop");
    expect(env.exportedInterface.match(/<method /g)).toHaveLength(1);
    expect(env.exportedInterface).toContain('name="Get"');
    const status = JSON.parse(env.runtime!.Get());
    expect(status.revision).toBe("__RED_DEV_BAR_REVISION__");
    expect(status.menu).toEqual({ visible: true, mapped: true, width: 75, height: 24 });
    expect(status.indicators[0].actors[0].label.text).toBe("RedRouter");
    bar.disable();
    expect(env.exportedPath).toBeNull();
    expect(env.runtime).toBeNull();
    expect(env.timers.size).toBe(0);
  });
});

describe("GNOME service health", () => {
  const row = (name: string, active: string, sub: string) =>
    [name, `${name} description`, "loaded", active, sub, "", "/", "0", "", "/"];
  const activate = (item: Actor) =>
    [...item.signals.values()].find(signal => signal.name === "activate")!.handler();
  const brand = (env: ReturnType<typeof fixture>) =>
    env.statusArea["reddb-menu"] as unknown as { _badge: Actor; _servicesItem: SubMenuItem };
  const texts = (menu: Menu) => menu.items.map(item => item.text);

  test("a healthy machine shows no badge, and oneshots that finished are not problems", () => {
    const env = fixture();
    env.setUnits([
      row("red-router.service", "active", "running"),
      row("red-dev-red-skills-watch.service", "inactive", "dead"),
      row("red-dev-desktop-tray-session.service", "active", "exited"),
    ]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._badge.visible).toBe(false);
    expect(brand(env)._servicesItem.text).toBe("Services");
    expect(texts(brand(env)._servicesItem.menu)).toEqual([
      "●  red-dev-desktop-tray-session  ·  exited",
      "●  red-dev-red-skills-watch  ·  inactive",
      "●  red-router  ·  running",
    ]);
    expect(env.notices).toEqual([]);
    bar.disable();
  });

  test("a failed service shows the badge, offers restart and a log, and is announced once", () => {
    const env = fixture();
    env.setUnits([row("redskilled.service", "failed", "failed"), row("dit.service", "active", "running")]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._badge.visible).toBe(true);
    expect(brand(env)._servicesItem.text).toBe("Services — 1 not running");
    expect(texts(brand(env)._servicesItem.menu)).toEqual([
      "●  dit  ·  running",
      "✕  redskilled  ·  failed",
      "↻  Restart redskilled",
    ]);
    // Polling again while it stays down must not nag.
    env.tick();
    env.tick();
    expect(env.notices).toEqual([{
      kind: "notify",
      title: "redskilled is not running",
      body: "Open the RedDB menu, Services, to see its log or restart it.",
    }]);

    // Recovered, then broken again: that is a new failure and is said again.
    env.setUnits([row("redskilled.service", "active", "running")]);
    env.tick();
    expect(brand(env)._badge.visible).toBe(false);
    env.setUnits([row("redskilled.service", "failed", "failed")]);
    env.tick();
    expect(env.notices).toHaveLength(2);
    bar.disable();
  });

  test("a crash-looping service counts as a problem before systemd gives up on it", () => {
    const env = fixture();
    env.setUnits([row("red-router.service", "activating", "auto-restart")]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._badge.visible).toBe(true);
    expect(texts(brand(env)._servicesItem.menu)[0]).toBe("↻  red-router  ·  activating");
    // Not failed yet, so nothing is announced.
    expect(env.notices).toEqual([]);
    bar.disable();
  });

  test("restart clears the start limit first, then restarts, then re-reads the state", () => {
    const env = fixture();
    env.setUnits([row("redskilled.service", "failed", "failed")]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    env.dbusCalls.length = 0;
    activate(brand(env)._servicesItem.menu.items[1]!);
    expect(env.dbusCalls.map(call => call.method)).toEqual([
      "ResetFailedUnit", "RestartUnit", "ListUnitsByPatterns",
    ]);
    expect(env.dbusCalls[0]!.args).toEqual(["redskilled.service"]);
    expect(env.dbusCalls[1]!.args).toEqual(["redskilled.service", "replace"]);
    bar.disable();
  });

  test("a restart that systemd refuses is reported, not swallowed", () => {
    const env = fixture();
    env.setUnits([row("redskilled.service", "failed", "failed")]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    env.failRestarts();
    activate(brand(env)._servicesItem.menu.items[1]!);
    expect(env.notices.at(-1)).toEqual({
      kind: "error", title: "Could not restart redskilled", body: "Unit not found",
    });
    bar.disable();
  });

  test("a service row opens a live journal tail without a shell", () => {
    const env = fixture();
    env.setUnits([row("redskilled.service", "failed", "failed")]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    activate(brand(env)._servicesItem.menu.items[0]!);
    const argv = env.launched.at(-1)!;
    expect(argv.slice(argv.indexOf("-e"))).toEqual([
      "-e", "journalctl", "--user", "-u", "redskilled.service", "-f", "-n", "200", "--output=short-iso",
    ]);
    expect(argv).not.toContain("sh");
    bar.disable();
  });

  test("the runtime status carries service health for doctor", () => {
    const env = fixture();
    env.setUnits([row("redskilled.service", "failed", "failed")]);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(JSON.parse(env.runtime!.Get()).services).toEqual([
      { name: "redskilled.service", active: "failed", sub: "failed", health: "failed" },
    ]);
    bar.disable();
  });
});

describe("GNOME updates, resources and logs", () => {
  const UPDATES = "/test/.local/state/red-dev/updates.json";
  const meminfo = (totalKiB: number, availableKiB: number) =>
    `MemTotal:       ${totalKiB} kB\nMemFree:         100 kB\nMemAvailable:   ${availableKiB} kB\n`;
  const brand = (env: ReturnType<typeof fixture>) => env.statusArea["reddb-menu"] as unknown as {
    _pressure: Actor; _memoryItem: MenuItem; _diskItem: MenuItem; _updateItem: MenuItem; menu: Menu;
  };
  const activate = (item: Actor) =>
    [...item.signals.values()].find(signal => signal.name === "activate")!.handler();

  test("names the tools that are behind, says so once, and says so again for a newer release", () => {
    const env = fixture();
    env.setFile(UPDATES, JSON.stringify({
      checkedAt: "2026-09-29T12:00:00Z",
      outdated: [{ name: "claude", current: "2.1.284", latest: "2.1.290" }, { name: "red-router", current: "0.37.0", latest: "0.38.0" }],
    }));
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._updateItem.text).toBe("Update workstation — 2 available");
    expect(env.notices).toEqual([{
      kind: "notify",
      title: "Updates available",
      body: "claude 2.1.290, red-router 0.38.0 — RedDB menu, Update workstation.",
    }]);

    env.tick();
    env.tick();
    expect(env.notices).toHaveLength(1);

    env.setFile(UPDATES, JSON.stringify({ outdated: [{ name: "claude", current: "2.1.284", latest: "2.1.291" }] }));
    env.tick();
    expect(env.notices).toHaveLength(2);
    expect(brand(env)._updateItem.text).toBe("Update workstation — 1 available");

    env.setFile(UPDATES, JSON.stringify({ outdated: [] }));
    env.tick();
    expect(brand(env)._updateItem.text).toBe("Update workstation");
    bar.disable();
  });

  test("an absent or broken updates file is simply nothing to say", () => {
    const env = fixture();
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._updateItem.text).toBe("Update workstation");
    env.setFile(UPDATES, "{ not json");
    env.tick();
    expect(brand(env)._updateItem.text).toBe("Update workstation");
    expect(env.notices).toEqual([]);
    bar.disable();
  });

  test("shows the numbers in the menu and nothing in the panel while there is room", () => {
    const env = fixture();
    env.setFile("/proc/meminfo", meminfo(16777216, 8388608));
    env.setDisk(100);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._memoryItem.text).toBe("Memory  ·  8.0 GiB free of 16 GiB");
    expect(brand(env)._diskItem.text).toBe("Disk  ·  100 GiB free");
    expect(brand(env)._pressure.visible).toBe(false);
    expect(env.notices).toEqual([]);
    bar.disable();
  });

  test("says so in the panel when memory gets tight, and interrupts only when it is critical", () => {
    const env = fixture();
    env.setFile("/proc/meminfo", meminfo(16777216, 1677722));
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._pressure.visible).toBe(true);
    expect(brand(env)._pressure.text).toBe("RAM 10% free");
    expect(env.notices).toEqual([]);

    env.setFile("/proc/meminfo", meminfo(16777216, 671088));
    env.tick();
    env.tick();
    expect(brand(env)._pressure.text).toBe("RAM 4% free");
    expect(env.notices.filter(notice => notice.title === "Memory is almost exhausted")).toHaveLength(1);

    env.setFile("/proc/meminfo", meminfo(16777216, 8388608));
    env.tick();
    expect(brand(env)._pressure.visible).toBe(false);
    bar.disable();
  });

  test("disk is tight by share of the disk, critical below 5%, and a big disk with room is fine", () => {
    const env = fixture();
    env.setFile("/proc/meminfo", meminfo(16777216, 8388608));
    env.setDisk(40, 600);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(brand(env)._pressure.text).toBe("Disk 40 GiB free");
    expect(env.notices).toEqual([]);

    env.setDisk(25, 600);
    env.tick();
    env.tick();
    expect(env.notices).toEqual([{
      kind: "notify", title: "The disk is almost full", body: "25 GiB free on the home filesystem.",
    }]);

    // 10% of a 4 TB disk is 400 GB: plenty, and not a warning.
    env.setDisk(400, 4000);
    env.tick();
    expect(brand(env)._pressure.visible).toBe(false);
    bar.disable();
  });

  test("a nearly full small disk is critical by absolute space too", () => {
    const env = fixture();
    env.setFile("/proc/meminfo", meminfo(16777216, 8388608));
    env.setDisk(4, 60);
    const bar = new env.RedDbBarExtension();
    bar.enable();
    expect(env.notices.map(notice => notice.title)).toEqual(["The disk is almost full"]);
    bar.disable();
  });

  test("more logs opens the resource guard's log through red-dev's resolver", () => {
    const env = fixture();
    const bar = new env.RedDbBarExtension();
    bar.enable();
    const logs = brand(env).menu.items.find(item => item.text === "More logs") as unknown as SubMenuItem;
    expect(logs.menu.items.map(item => item.text)).toEqual(["RedRouter", "Redskilled", "Resource guard"]);
    activate(logs.menu.items[2]!);
    expect(env.launched.at(-1)).toEqual(["/test/.local/share/mise/shims/red-dev", "logs", "--app", "workloads", "--open"]);
    bar.disable();
  });

  test("the runtime status carries updates and resources for doctor", () => {
    const env = fixture();
    env.setFile("/proc/meminfo", meminfo(16777216, 8388608));
    env.setFile(UPDATES, JSON.stringify({ outdated: [{ name: "claude", current: "1", latest: "2" }] }));
    const bar = new env.RedDbBarExtension();
    bar.enable();
    const status = JSON.parse(env.runtime!.Get());
    expect(status.updates).toEqual([{ name: "claude", current: "1", latest: "2" }]);
    expect(status.resources.memory.level).toBe("ok");
    expect(status.resources.disk.level).toBe("ok");
    bar.disable();
  });
});
