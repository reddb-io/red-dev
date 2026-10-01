/** Execute the real panel component with fake Shell actors and deferred subprocesses. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
const source = readFileSync(`${import.meta.dir}/../config/gnome/reddb-bar/extension.gnome`, "utf8");
function fixture() {
  const processes: { argv: string[]; killed: boolean; callback?: (child: unknown, result: null) => void; output: string; successful: boolean; force_exit(): void; communicate_utf8_finish(): unknown[]; communicate_utf8_async(_input: null, _cancel: null, callback: (child: unknown, result: null) => void): void }[] = [];
  const timers = new Map<number, () => void>(); let next = 1;
  const menu = { callback: undefined as undefined | ((_menu: unknown, open: boolean) => void), connect(_event: string, callback: (_menu: unknown, open: boolean) => void) { this.callback = callback; return 1; }, disconnect() {} };
  class Button { menu = menu; accessible_name = ""; _init() {} add_style_class_name() {} add_child() {} destroy() {} }
  class Label { text: string; constructor(options: { text: string }) { this.text = options.text; } }
  const Gio = { SubprocessFlags: { STDOUT_PIPE: 1, STDERR_PIPE: 2 }, Subprocess: { new(argv: string[]) {
    const child = { argv, killed: false, successful: true, output: '{"preferences":{"defaultAgent":"codex"}}', callback: undefined as undefined | ((child: unknown, result: null) => void), force_exit() { this.killed = true; }, get_successful() { return this.successful; }, communicate_utf8_finish() { return [true, this.output, ""]; }, communicate_utf8_async(_input: null, _cancel: null, callback: (child: unknown, result: null) => void) { this.callback = callback; } }; processes.push(child); return child;
  } } };
  const GLib = { PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false, FileTest: { IS_EXECUTABLE: 1 }, file_test: () => true, get_home_dir: () => "/fixture", timeout_add_seconds(_priority: number, _seconds: number, callback: () => void) { timers.set(next, callback); return next++; }, source_remove(id: number) { timers.delete(id); } };
  const GObject = { registerClass(cls: new () => Button & { _init(): void }) { return class extends cls { constructor() { super(); this._init(); } }; } };
  const functions = source.slice(source.indexOf("function firstExecutable"), source.indexOf("function command"));
  const component = source.slice(source.indexOf("const AgentsMenu"), source.indexOf("function actorState"));
  const build = new Function("Gio", "GLib", "GObject", "PanelMenu", "St", "themeMenu", "openMenuOnSecondaryClick", "item", "command", "herdr", "openDiagnosticLog", `${functions}\n${component}\nreturn AgentsMenu;`);
  const Component = build(Gio, GLib, GObject, { Button }, { BoxLayout: class { add_child() {} }, Icon: class {}, Label }, () => {}, () => 0, (_menu: unknown, text: string) => ({ label: { text } }), () => {}, () => {}, () => {});
  const actor = new Component();
  const finish = () => { const child = processes.at(-1)!; child.callback!(child, null); };
  return { actor, processes, timers, menu, finish };
}
test("agent label reads canonical JSON asynchronously, refreshes on menu open and bounds its subprocess", () => {
  const f = fixture(); expect(f.actor._agentLabel.text).toBe("Agent");
  expect(f.processes[0]?.argv).toEqual(["/fixture/.local/share/mise/installs/red-dev/latest/red-dev", "config", "--json"]);
  f.menu.callback!(null, true); expect(f.processes).toHaveLength(1); // one pending read
  f.finish(); expect(f.actor._agentLabel.text).toBe("Codex CLI"); expect(f.actor._launchRow.label.text).toBe("Launch Codex CLI"); expect(f.timers.size).toBe(0);
  f.menu.callback!(null, true); expect(f.processes).toHaveLength(2); f.processes[1]!.output = '{"preferences":{"defaultAgent":"redcode"}}'; f.finish(); expect(f.actor._agentLabel.text).toBe("RedCode");
  f.menu.callback!(null, true); const child = f.processes[2]!; f.timers.values().next().value!(); expect(child.killed).toBe(true);
  child.successful = false; f.finish(); expect(f.actor._agentLabel.text).toBe("RedCode");
});
test("destroying the panel ends its child and prevents a late result updating actors", () => {
  const f = fixture(); f.actor.destroy(); expect(f.processes[0]!.killed).toBe(true); expect(f.timers.size).toBe(0);
  f.finish(); expect(f.actor._agentLabel.text).toBe("Agent");
});
