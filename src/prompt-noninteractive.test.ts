import { expect, test } from "bun:test";

const PROMPT = `${import.meta.dir}/../config/bash/prompt.sh`;

test("a non-interactive dumb shell never initializes starship", () => {
  const script = `
    starship() {
      printf 'STARSHIP_CALLED\\n' >&2
      printf ':'
    }
    export TERM=dumb
    . '${PROMPT}'
  `;
  const proc = Bun.spawnSync(["bash", "--noprofile", "--norc", "-c", script], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stderr = new TextDecoder().decode(proc.stderr);

  expect(proc.exitCode).toBe(0);
  expect(stderr).not.toContain("STARSHIP_CALLED");
});
