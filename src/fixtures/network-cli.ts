import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../bounded-command.ts";
import type { NetworkReport } from "../network-diagnostics.ts";

/** Exercise the real CLI dispatch with local executables and no external requests. */
export async function verifyNetworkCli(argv: string[]): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "red-dev-network-cli-"));
  const bin = join(root, "bin");
  mkdirSync(bin);
  const credential = "gho_fixture_never_export_this";
  writeFileSync(join(bin, "gh"), `#!/bin/sh\nprintf '%s\\n' '${credential}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "mise"), `#!/bin/sh
case "$1" in
  token) printf 'Source: credential_command\\nToken: ${credential}\\n' ;;
  ls-remote) printf '1.0.179\\n' ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, "curl"), `#!/bin/sh
if [ "$RED_DEV_NETWORK_FIXTURE_FAIL" = 1 ]; then
  printf 'curl: (28) Operation timed out\\n' >&2
  exit 28
fi
printf '200'
`, { mode: 0o755 });
  try {
    for (const failed of [false, true]) {
      const result = await runBounded([...argv, "network", "--json"], {
        timeoutMs: 5_000,
        env: {
          ...process.env, HOME: root, PATH: bin, Path: bin,
          XDG_STATE_HOME: join(root, "state"), XDG_CONFIG_HOME: join(root, "config"),
          MISE_DATA_DIR: join(root, "mise"), RED_DEV_NETWORK_FIXTURE_FAIL: failed ? "1" : "0",
        },
      });
      if (result.timedOut || result.exitCode !== (failed ? 1 : 0)) {
        throw new Error(`network CLI exit ${result.exitCode}: ${result.stderr} ${result.stdout}`);
      }
      const report = JSON.parse(result.stdout) as NetworkReport;
      if (report.schema !== "red.network-diagnostics.v1" || report.checks.length !== 6) {
        throw new Error("network CLI did not dispatch to the diagnostic report");
      }
      const http = report.checks.filter(check => /GitHub API|GitHub release|npm registry/.test(check.name));
      if (http.length !== 3 || !http.every(check => failed
        ? check.status === "failed" && check.failure === "timeout"
        : check.status === "ok")) throw new Error("network CLI did not report HTTP outcomes");
      if (result.stdout.includes(credential) || result.stderr.includes(credential)) {
        throw new Error("network CLI leaked credential output");
      }
      if (existsSync(join(root, "state", "red-dev"))) {
        throw new Error("read-only network diagnostics created a transcript");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
