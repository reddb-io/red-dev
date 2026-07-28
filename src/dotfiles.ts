/**
 * Shell configuration deployment.
 *
 * This is the layer that actually delivers "same experience" — the
 * aliases that normalise Debian's renames, the prompt, the PATH
 * handling that keeps WSL interop alive. Installing tools without it
 * produces a machine with the right binaries and none of the feel.
 *
 * The files travel inside the binary as text imports rather than being
 * read from a checkout, because the normal way to get red-dev is to
 * download one executable. Verified to survive `bun build --compile`
 * before anything was built on top of it; see scripts/embed-smoke.ts.
 */

import { existsSync } from "node:fs";
import { log } from "./log.ts";

import rcSh from "../config/bash/rc.sh" with { type: "text" };
import pathSh from "../config/bash/path.sh" with { type: "text" };
import initSh from "../config/bash/init.sh" with { type: "text" };
import aliasesSh from "../config/bash/aliases.sh" with { type: "text" };
import promptSh from "../config/bash/prompt.sh" with { type: "text" };

const FILES: Record<string, string> = {
  "rc.sh": rcSh,
  "path.sh": pathSh,
  "init.sh": initSh,
  "aliases.sh": aliasesSh,
  "prompt.sh": promptSh,
};

/** The line we add to the user's shell rc, and the marker we look for. */
const SOURCE_LINE = "source ~/.local/share/red-dev/config/bash/rc.sh";
const MARKER = "red-dev/config/bash/rc.sh";

function home(): string {
  const h = process.env["HOME"];
  if (!h) throw new Error("HOME is not set");
  return h;
}

async function writeIfChanged(path: string, content: string): Promise<boolean> {
  if (existsSync(path)) {
    const current = await Bun.file(path).text();
    if (current === content) return false;
  }
  await Bun.write(path, content);
  return true;
}

/**
 * Append our source line to ~/.bashrc rather than replacing the file.
 *
 * A shell rc is the user's, and it commonly holds work they care about
 * more than anything we are installing. Appending — after a backup, and
 * only when our marker is absent — keeps a re-run harmless and keeps a
 * pre-existing configuration intact.
 */
async function wireShellRc(): Promise<void> {
  const bashrc = `${home()}/.bashrc`;
  const existing = existsSync(bashrc) ? await Bun.file(bashrc).text() : "";

  if (existing.includes(MARKER)) {
    log.skip("~/.bashrc already sources red-dev");
    return;
  }

  if (existing.length > 0) {
    await Bun.write(`${bashrc}.red-dev-backup`, existing);
    log.step(`backed up ~/.bashrc to ~/.bashrc.red-dev-backup`);
  }

  const block = [
    existing.trimEnd(),
    "",
    "# Added by red-dev. Remove this line to opt out; the files stay in",
    "# ~/.local/share/red-dev and nothing else in this file was touched.",
    SOURCE_LINE,
    "",
  ].join("\n");

  await Bun.write(bashrc, block);
  log.ok("~/.bashrc now sources red-dev");
}

export async function installDotfiles(): Promise<void> {
  const dest = `${home()}/.local/share/red-dev/config/bash`;
  await Bun.spawn(["mkdir", "-p", dest], { stdout: "ignore" }).exited;

  let changed = 0;
  for (const [name, content] of Object.entries(FILES)) {
    if (await writeIfChanged(`${dest}/${name}`, content)) changed++;
  }

  if (changed > 0) {
    log.ok(`dotfiles: ${changed} file(s) written to ${dest}`);
  } else {
    log.skip("dotfiles already current");
  }

  await wireShellRc();
}
