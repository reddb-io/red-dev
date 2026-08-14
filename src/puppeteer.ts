/** Puppeteer CLI, its matching Chrome for Testing, and a launch smoke test. */

import { existsSync } from "node:fs";
import { executablesEnvironment, npmArgv, resolveNpm } from "./agents.ts";
import { log, RedError } from "./log.ts";
import type { Platform } from "./platform.ts";
import { requireSudo, spawnLoggedCapture } from "./providers.ts";

async function checked(
  argv: string[],
  env: Record<string, string | undefined>,
  failure: string,
): Promise<string> {
  const result = await spawnLoggedCapture(argv, { env });
  if (result.code !== 0) throw new RedError(`${failure} (exit ${result.code})`);
  return result.out.trim();
}

/** Global executable path npm creates for Puppeteer's CLI. */
export function puppeteerCli(prefix: string, p: Platform): string {
  return p.os === "windows" ? `${prefix}/puppeteer.cmd` : `${prefix}/bin/puppeteer`;
}

export async function installPuppeteer(p: Platform): Promise<void> {
  const { runtimeTool, useRuntimes } = await import("./runtimes.ts");
  let npm = await resolveNpm();
  let node = await runtimeTool("node");
  if (!npm || !node) {
    log.info("Puppeteer needs Node; installing node@24 through mise first");
    await useRuntimes(["node@24"]);
    npm = await resolveNpm();
    node = await runtimeTool("node");
  }
  if (!npm || !node) throw new RedError("mise installed Node, but npm/node still cannot be resolved");

  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const env = executablesEnvironment([npm, node], process.platform, {
    ...process.env,
    ...(home ? { PUPPETEER_CACHE_DIR: `${home.replace(/\\/g, "/")}/.cache/puppeteer` } : {}),
  });
  log.info("installing the Puppeteer CLI globally (browser download is the next explicit step)");
  await checked(
    npmArgv(npm, ["install", "-g", "puppeteer@latest", "--ignore-scripts", "--no-audit", "--no-fund"]),
    { ...env, PUPPETEER_SKIP_DOWNLOAD: "true" },
    "npm could not install Puppeteer",
  );

  const prefix = await checked(npmArgv(npm, ["prefix", "-g"]), env, "npm could not report its global prefix");
  const cli = puppeteerCli(prefix.replace(/\\/g, "/"), p);
  if (!existsSync(cli)) throw new RedError(`Puppeteer installed, but its CLI is missing at ${cli}`);

  const browserArgs = ["browsers", "install", "chrome"];
  log.info("downloading the matching Chrome for Testing into the user's cache");
  await checked(npmArgv(cli, browserArgs), env, "Puppeteer could not install Chrome for Testing");

  if (p.os !== "windows") {
    // Puppeteer's documented --install-deps contract requires root. Download
    // as the user first, then point the elevated dependency pass at that same
    // cache: the CLI explicitly installs deps even when Chrome is already
    // present, without leaving a second root-owned browser under /root.
    await requireSudo();
    log.info("installing Chrome's Ubuntu libraries through Puppeteer's --install-deps contract");
    await checked(
      ["sudo", "-E", ...npmArgv(cli, [...browserArgs, "--install-deps"])],
      env,
      "Puppeteer could not install Chrome's Ubuntu dependencies",
    );
  }

  const root = await checked(npmArgv(npm, ["root", "-g"]), env, "npm could not report its global module root");
  const packageRoot = `${root.replace(/\\/g, "/")}/puppeteer`;
  log.info("launching the installed browser once in headless mode");
  const smoke =
    "const p=require(process.argv[1]);" +
    "p.launch({headless:true,args:['--no-sandbox']})" +
    ".then(async b=>{console.log(await b.version());await b.close()})" +
    ".catch(e=>{console.error(e);process.exit(1)})";
  await checked([node, "-e", smoke, packageRoot], env, "Chrome was downloaded but its headless launch failed");
  log.ok("Puppeteer CLI + Chrome for Testing are ready");
}
