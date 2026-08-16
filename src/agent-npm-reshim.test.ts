import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded } from "./bounded-command.ts";

const created: string[] = [];

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("npm agents installed through mise", () => {
  test("do not inherit mise's unbounded automatic reshim", async () => {
    const dir = mkdtempSync(join(tmpdir(), "red-dev-agent-npm-"));
    created.push(dir);
    const pathDir = join(dir, "path");
    const nodeBin = join(dir, "node-bin");
    mkdirSync(pathDir);
    mkdirSync(nodeBin);
    const fakeNpm = join(nodeBin, "npm");
    const fakeMise = join(pathDir, "mise");

    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'changed 7 packages in 10s\\n'
if [ -z "\${MISE_SKIP_RESHIM:-}" ]; then
  printf 'Reshimming mise 24...\\n' >&2
  sleep 30
fi
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$(dirname "$0")/fixture-agent"
chmod +x "$(dirname "$0")/fixture-agent"
`,
    );
    writeFileSync(
      fakeMise,
      `#!/usr/bin/env bash
if [ "\${1:-}" = which ] && [ "\${2:-}" = npm ]; then
  printf '%s\\n' ${JSON.stringify(fakeNpm)}
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeNpm, 0o755);
    chmodSync(fakeMise, 0o755);

    const harness = join(dir, "harness.ts");
    const agents = join(import.meta.dir, "agents.ts");
    writeFileSync(
      harness,
      `import { installAgent, isAgentInstalled } from ${JSON.stringify(agents)};
const fixture = {
  key: "fixture",
  label: "Fixture agent",
  about: "fixture",
  cmd: "fixture-agent",
  recommended: false,
  npm: "fixture-agent",
};
await installAgent(fixture, {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: false, flatpak: false },
});
console.log("INSTALL_SETTLED=" + isAgentInstalled(fixture));
`,
    );

    const result = await runBounded([process.execPath, harness], {
      timeoutMs: 750,
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("changed 7 packages in 10s");
    expect(result.stdout).toContain("INSTALL_SETTLED=true");
    expect(result.stdout + result.stderr).not.toContain("Reshimming mise");
  });

  test("and neither does updating them, which spawns the same npm again", async () => {
    // `red-dev agents update` reinstalls the package globally, which is
    // the same mise-wrapped npm call with the same unbounded reshim
    // waiting behind it. Suppressing it on the install path and not on
    // the update path would put the hang straight back, in the command
    // people run most often.
    const dir = mkdtempSync(join(tmpdir(), "red-dev-agent-npm-update-"));
    created.push(dir);
    const pathDir = join(dir, "path");
    const nodeBin = join(dir, "node-bin");
    mkdirSync(pathDir);
    mkdirSync(nodeBin);
    const fakeNpm = join(nodeBin, "npm");
    const fakeMise = join(pathDir, "mise");

    writeFileSync(
      fakeNpm,
      `#!/usr/bin/env bash
set -euo pipefail
printf 'npm-argv: %s\\n' "$*"
printf 'changed 7 packages in 10s\\n'
if [ -z "\${MISE_SKIP_RESHIM:-}" ]; then
  printf 'Reshimming mise 24...\\n' >&2
  sleep 30
fi
printf '#!/usr/bin/env bash\\nexit 0\\n' > "$(dirname "$0")/fixture-agent"
chmod +x "$(dirname "$0")/fixture-agent"
`,
    );
    writeFileSync(
      fakeMise,
      `#!/usr/bin/env bash
if [ "\${1:-}" = which ] && [ "\${2:-}" = npm ]; then
  printf '%s\\n' ${JSON.stringify(fakeNpm)}
  exit 0
fi
exit 1
`,
    );
    chmodSync(fakeNpm, 0o755);
    chmodSync(fakeMise, 0o755);

    const harness = join(dir, "harness.ts");
    const agents = join(import.meta.dir, "agents.ts");
    const update = join(import.meta.dir, "agent-update.ts");
    writeFileSync(
      harness,
      `import { installAgent } from ${JSON.stringify(agents)};
import { updateAgents } from ${JSON.stringify(update)};
const fixture = {
  key: "fixture",
  label: "Fixture agent",
  about: "fixture",
  cmd: "fixture-agent",
  recommended: false,
  npm: "fixture-agent",
};
const platform = {
  os: "linux",
  distro: "ubuntu",
  version: "24.04",
  codename: "noble",
  env: "wsl",
  arch: "x64",
  caps: { apt: true, gui: false, systemd: true, winget: true, flatpak: false },
};
await installAgent(fixture, platform);
const outcomes = await updateAgents([fixture], platform);
console.log("UPDATE_STATE=" + outcomes[0].state);
`,
    );

    const result = await runBounded([process.execPath, harness], {
      timeoutMs: 3_000,
      env: { ...process.env, PATH: `${pathDir}:${process.env.PATH ?? ""}` },
    });

    expect(result.timedOut).toBe(false);
    expect(result.exitCode).toBe(0);
    // The update ran its own npm call, pinned to latest, and settled.
    expect(result.stdout).toContain("npm-argv: install -g fixture-agent@latest");
    expect(result.stdout).toContain("UPDATE_STATE=updated");
    expect(result.stdout + result.stderr).not.toContain("Reshimming mise");
  });
});
