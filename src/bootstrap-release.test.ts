/**
 * The stable bootstrap must not spend a GitHub API request merely to find a
 * public release asset whose name is part of our own release contract.
 *
 * Anonymous API limits are per public IP and unrelated to the PAT/App pools
 * RedSkills reports. A fresh machine behind a shared/NATed address can
 * therefore receive 403 before red-dev has even downloaded. GitHub's public
 * `releases/latest/download/<asset>` redirect has no such API dependency.
 */

import { chmodSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";

describe("the stable bootstrap release resolver", () => {
  test("installs through the public latest redirect when the anonymous API is exhausted", async () => {
    const root = mkdtempSync(`${tmpdir()}/red-dev-bootstrap-release-`);
    const fakeBin = `${root}/bin`;
    await Bun.$`mkdir -p ${fakeBin}`.quiet();
    const calls = `${root}/curl.calls`;
    const curl = `${fakeBin}/curl`;

    await Bun.write(
      curl,
      `#!/bin/sh
set -eu
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\n' "$url" >> '${calls}'
case "$url" in
  https://api.github.com/*)
    [ -z "$out" ] || printf '%s\n' '{"message":"API rate limit exceeded"}' > "$out"
    printf '403'
    ;;
  https://github.com/reddb-io/red-dev/releases/latest/download/red-dev-linux-x64)
    printf '%s\n' '#!/bin/sh' 'exit 0' > "$out"
    ;;
  *)
    printf '%s\n' "unexpected URL: $url" >&2
    exit 22
    ;;
esac
`,
    );
    chmodSync(curl, 0o700);

    const proc = Bun.spawn(["sh", `${import.meta.dir}/../boot.sh`], {
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        HOME: root,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        RED_DEV_NO_LAUNCH: "1",
      },
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    const requested = readFileSync(calls, "utf8");

    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(requested).toContain(
      "https://github.com/reddb-io/red-dev/releases/latest/download/red-dev-linux-x64",
    );
    expect(requested).not.toContain("api.github.com");
    expect(await Bun.file(`${root}/.local/bin/red-dev`).exists()).toBe(true);
  });
});
