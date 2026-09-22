import { describe, expect, test } from "bun:test";
import extensionSource from "../config/gnome/reddb-bar/extension.gnome" with { type: "text" };

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
  signals = new Map<number, { name: string; handler: () => void }>();
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
  connect(name: string, handler: () => void) {
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
  addMenuItem(item: Actor) { this.items.push(item); }
  removeAll() { this.items = []; }
}

class MenuItem extends Actor {
  constructor(label: string) { super({ text: label }); }
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
  let exportedPath: string | null = null;
  let exportedInterface = "";
  let runtime: { Get: () => string } | null = null;
  const workspace = new Actor();
  const launched: string[][] = [];
  const Gio = {
    SubprocessFlags: { STDOUT_PIPE: 1, STDERR_PIPE: 2 },
    Subprocess: { new: (argv: string[]) => { launched.push(argv); return { communicate_utf8_async: () => {} }; } },
    icon_new_for_string: (path: string) => path,
    DBus: { session: {} },
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
    PRIORITY_DEFAULT: 0,
    SOURCE_CONTINUE: true,
    timeout_add_seconds: (_priority: number, seconds: number, callback: () => boolean) => {
      expect(seconds).toBeGreaterThanOrEqual(1);
      timers.set(1, callback);
      return 1;
    },
    source_remove: (id: number) => timers.delete(id),
    get_home_dir: () => "/test",
    FileTest: { IS_EXECUTABLE: 1 },
    file_test: () => true,
    file_get_contents: () => [false, new Uint8Array()],
  };
  const source = extensionSource
    .replace(/^import .*;\n/gm, "")
    .replace("export default class RedDbBarExtension", "class RedDbBarExtension");
  const evaluate = new Function("Gio", "GLib", "GObject", "St", "Extension", "Main",
    "PanelMenu", "PopupMenu", "global", `${source}\nreturn {NamedTrayLabels, RedDbBarExtension};`);
  const classes = evaluate(Gio, GLib, { registerClass: (value: unknown) => value },
    { Label: Actor, Icon: Actor, BoxLayout: Actor }, class {},
    { panel: {
      statusArea,
      add_style_class_name: () => {},
      remove_style_class_name: () => {},
      addToStatusArea: (id: string, actor: Actor) => { statusArea[id] = actor; },
    } },
    { Button }, { PopupImageMenuItem: MenuItem, PopupSeparatorMenuItem: Actor },
    { workspace_manager: Object.assign(workspace, { n_workspaces: 0, get_active_workspace_index: () => 0 }) },
  ) as { NamedTrayLabels: new () => Labels; RedDbBarExtension: new () => Bar };
  return {
    ...classes, statusArea, timers, launched,
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
