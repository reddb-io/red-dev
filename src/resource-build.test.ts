import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildEnvironment, takeBuildSlot } from "./resource-build.ts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => rmSync(p, { recursive: true, force: true })));
function fixture() { const r = mkdtempSync(join(tmpdir(), "resource-build-")); roots.push(r); return r; }
test("Cargo choices preserve explicit job arguments and shell settings", () => {
  expect(buildEnvironment(['cargo', 'check'], 4, {}).CARGO_BUILD_JOBS).toBe('4');
  expect(buildEnvironment(['cargo', 'check', '-j2'], 4, {}).CARGO_BUILD_JOBS).toBeUndefined();
  expect(buildEnvironment(['cargo', 'check', '--jobs=2'], 4, {}).CARGO_BUILD_JOBS).toBeUndefined();
  expect(buildEnvironment(['cargo', 'check'], 4, { CARGO_BUILD_JOBS: '7' }).CARGO_BUILD_JOBS).toBe('7');
  expect(buildEnvironment(['cargo', 'test', '--', '-j2'], 4, {}).CARGO_BUILD_JOBS).toBe('4');
});
test("participating builds share slots, and reducing capacity does not bypass existing builds", () => {
  const r = fixture(); const first = takeBuildSlot(2, r)!, second = takeBuildSlot(2, r)!;
  expect(first).not.toBeNull(); expect(second).not.toBeNull(); expect(takeBuildSlot(1, r)).toBeNull();
  first.release(); expect(takeBuildSlot(1, r)).toBeNull(); second.release();
  const next = takeBuildSlot(1, r); expect(next).not.toBeNull(); next!.release();
});
test("unknown launch ownership preserves capacity; proven dead holders can be recovered", () => {
  const r = fixture(); mkdirSync(join(r, '0'));
  writeFileSync(join(r, '0/owner.json'), JSON.stringify({ pid: 2147483647, token: 'dead', phase: 'queued' }));
  const next = takeBuildSlot(1, r); expect(next).not.toBeNull(); next!.release();
  mkdirSync(join(r, '0')); writeFileSync(join(r, '0/owner.json'), JSON.stringify({ pid: 2147483647, token: 'uncertain', phase: 'launching' }));
  expect(() => takeBuildSlot(1, r)).toThrow('ownership unresolved'); expect(readFileSync(join(r, '0/owner.json'), 'utf8')).toContain('uncertain');
});
test.skipIf(process.platform === 'win32')("real concurrent CLI builds serialize across projects and preserve argv, job counts and exit codes", async () => {
  const r = fixture(); const a = join(r, 'a'), b = join(r, 'b'); mkdirSync(a); mkdirSync(b);
  for (const p of [a, b]) { writeFileSync(join(p, 'Cargo.toml'), '[package]\nname="fixture"\n'); mkdirSync(join(p, '.red-dev')); writeFileSync(join(p, '.red-dev/resources.json'), '{"schema":1,"jobs":3}'); }
  const record = join(r, 'observed.jsonl'); const cargo = join(r, 'cargo');
  writeFileSync(cargo, `#!${process.execPath}\nimport {appendFileSync} from "node:fs";\nappendFileSync(${JSON.stringify(record)}, JSON.stringify({event:"start",pid:process.pid,at:Date.now(),jobs:process.env.CARGO_BUILD_JOBS,args:process.argv.slice(2)})+"\\n"); await Bun.sleep(450); appendFileSync(${JSON.stringify(record)}, JSON.stringify({event:"end",pid:process.pid,at:Date.now()})+"\\n"); process.exit(7);\n`, { mode: 0o755 });
  const profile = join(r, 'profile.json'); writeFileSync(profile, '{"schema":1,"name":"ubuntu-desktop","tools":{},"resources":{"mode":"custom","buildSlots":1}}');
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: r, XDG_CONFIG_HOME: join(r, 'config'), XDG_STATE_HOME: join(r, 'state'), RED_DEV_PROFILE_FILE: profile, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' };
  delete env.CARGO_BUILD_JOBS;
  const main = fileURLToPath(new URL('./main.ts', import.meta.url));
  const children = [a, b].map(p => Bun.spawn([process.execPath, main, 'resources', 'run', '--project', p, '--', cargo, 'check', 'literal space'], { env, stdout: 'pipe', stderr: 'pipe' }));
  const results = await Promise.all(children.map(async c => Promise.all([c.exited, new Response(c.stdout).text(), new Response(c.stderr).text()])));
  expect(results.map(r => r[0])).toEqual([7, 7]); expect(results.map(r => r[2])).toEqual(['', '']);
  const events = readFileSync(record, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  expect(events.map(e => e.event)).toEqual(['start', 'end', 'start', 'end']);
  expect(events.filter(e => e.event === 'start').every(e => e.jobs === '3' && e.args[1] === 'literal space')).toBe(true);
}, 10000);
