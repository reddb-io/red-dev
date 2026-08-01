/**
 * Blender, which fits none of the providers.
 *
 * apt has 4.0.2 on Ubuntu 24.04 and winget has 5.2.0, and for this tool
 * that gap is not cosmetic: a .blend written by 5.2 does not open in
 * 4.0. Installing "Blender" on the two halves of one machine and
 * getting files that cannot cross between them is worse than not
 * offering it.
 *
 * The `gh` provider cannot help either. Blender publishes no binaries on
 * GitHub, ships .tar.xz which that provider does not read, and is a
 * 1.2 GB tree — python, datafiles, shared objects — rather than a binary
 * to drop on PATH. Lifting one executable out of it produces something
 * that starts and then cannot find its own runtime.
 *
 * So: the official build, extracted whole, with a symlink pointing into
 * it. No sudo, nothing owned by a package manager.
 */

import { existsSync } from "node:fs";
import { log, RedError } from "./log.ts";

const INDEX = "https://download.blender.org/release/";

/**
 * The newest stable release, asked of Blender rather than pinned here.
 *
 * A version baked into this file is wrong the week after it is written,
 * and the failure is silent — a converge keeps installing an old build
 * and reporting success. The listing is a plain directory index, which
 * is not an API and could change; the caller treats a parse failure as
 * "cannot install now" rather than falling back to something stale.
 */
export async function latestBlender(): Promise<{ version: string; url: string }> {
  const index = await fetch(INDEX, { signal: AbortSignal.timeout(30_000) })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");

  // Sorted numerically on both halves. Lexical sorting puts Blender5.10
  // before Blender5.2, which is the kind of bug that only shows up two
  // years after it is written.
  const series = [...index.matchAll(/Blender(\d+)\.(\d+)\//g)]
    .map((m) => ({ major: Number(m[1]), minor: Number(m[2]), dir: m[0] }))
    .sort((a, b) => a.major - b.major || a.minor - b.minor)
    .pop();
  if (!series) throw new RedError(`could not read the Blender release index at ${INDEX}`);

  const dir = `${INDEX}${series.dir}`;
  const listing = await fetch(dir, { signal: AbortSignal.timeout(30_000) })
    .then((r) => (r.ok ? r.text() : ""))
    .catch(() => "");

  const file = [...listing.matchAll(/blender-(\d+\.\d+\.\d+)-linux-x64\.tar\.xz/g)]
    .map((m) => ({ version: m[1] as string, name: m[0] }))
    .sort((a, b) => {
      const [am, an, ap] = a.version.split(".").map(Number) as [number, number, number];
      const [bm, bn, bp] = b.version.split(".").map(Number) as [number, number, number];
      return am - bm || an - bn || ap - bp;
    })
    .pop();
  if (!file) throw new RedError(`no linux-x64 build listed under ${dir}`);

  return { version: file.version, url: `${dir}${file.name}` };
}

function home(): string {
  const h = process.env["HOME"] ?? process.env["USERPROFILE"];
  if (!h) throw new RedError("neither HOME nor USERPROFILE is set");
  return h.replace(/\\/g, "/");
}

/** What is installed here, or null. */
export async function installedBlender(): Promise<string | null> {
  const bin = `${home()}/.local/bin/blender`;
  if (!existsSync(bin)) return null;
  try {
    const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return /Blender (\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Install or update Blender for this user.
 *
 * The desktop entry is not decoration: WSLg publishes .desktop files to
 * the Windows Start Menu, so it is what makes a Linux Blender openable
 * the same way every other application on the machine is.
 */
export async function installBlender(): Promise<void> {
  const { version, url } = await latestBlender();
  const current = await installedBlender();
  if (current === version) {
    log.skip(`blender ${version} already installed`);
    return;
  }

  const root = `${home()}/.local/share/blender`;
  const tmp = `/tmp/red-blender-${version}.tar.xz`;
  log.step(`blender ${version}${current ? ` (replacing ${current})` : ""}`);

  const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) }).catch(
    (err: unknown) => {
      throw new RedError(`blender download failed: ${(err as Error).message}`);
    },
  );
  if (!res.ok) throw new RedError(`blender download failed ${res.status}: ${url}`);
  // Read before writing, for the reason ghInstall documents at length: a
  // Response handed straight to Bun.write never returns on a large
  // asset, and this one is 384 MB.
  await Bun.write(tmp, await res.arrayBuffer());

  const run = async (cmd: string[]): Promise<void> => {
    const { spawnLogged } = await import("./providers.ts");
    if ((await spawnLogged(cmd)) !== 0) throw new RedError(`${cmd[0]} failed`);
  };

  await run(["rm", "-rf", root]);
  await run(["mkdir", "-p", root, `${home()}/.local/bin`, `${home()}/.local/share/applications`]);
  await run(["tar", "-xJf", tmp, "-C", root, "--strip-components=1"]);
  await run(["ln", "-sf", `${root}/blender`, `${home()}/.local/bin/blender`]);
  await run(["rm", "-f", tmp]);

  const icon = existsSync(`${root}/blender.svg`) ? `${root}/blender.svg` : "applications-graphics";
  await Bun.write(
    `${home()}/.local/share/applications/blender.desktop`,
    [
      "[Desktop Entry]",
      "Type=Application",
      "Name=Blender",
      "Comment=3D creation suite",
      `Exec=${home()}/.local/bin/blender %f`,
      `Icon=${icon}`,
      "Terminal=false",
      "Categories=Graphics;3DGraphics;",
      "MimeType=application/x-blender;",
      "",
    ].join("\n"),
  );

  log.ok(`blender ${version} installed to ${root}`);
}
