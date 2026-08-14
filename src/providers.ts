/**
 * Provider execution. Each provider knows how to make one tool present
 * on one platform; the caller decides which provider applies.
 *
 * Every provider must be idempotent: re-running after a partial failure
 * is the normal recovery path, not an edge case. A fresh provision can
 * die halfway through for reasons that have nothing to do with us — we
 * lost one to a full host disk while writing this.
 */

import { removeTemp, tempDir, tempFile } from "./temp.ts";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { formatBytes, formatDuration, log, logIsCaptured, RedError } from "./log.ts";
import { parseChecksums, pickChecksumAsset, sha256Hex, verifyChecksum } from "./checksum.ts";
import type { Provider } from "./manifest.ts";
import type { Platform } from "./platform.ts";
import { startProcessHeartbeat } from "./process-heartbeat.ts";
import { missingRights } from "./rights.ts";
import { tlsTrustFailure, unattendedEnvironment } from "./unattended.ts";

/**
 * Provisioning never delegates a question to a child process.
 *
 * The public command may itself be interactive, but once the user has chosen
 * what to install every provider is unattended. A child that unexpectedly
 * prompts must receive EOF and fail instead of stealing keys from the TUI or
 * waiting forever in CI, over SSH, or at an ordinary terminal.
 */
export const providerStdinMode = (
  _stdinIsTTY: boolean | undefined = process.stdin.isTTY,
): "ignore" => "ignore";

/**
 * Forward a child's stream into the log, one line at a time.
 *
 * Carriage returns are resolved the way a terminal would: a progress
 * line that rewrites itself becomes the last thing it said, rather than
 * every state it passed through concatenated into one unreadable row.
 */
async function pumpToLog(
  stream: ReadableStream<Uint8Array> | null,
  activity: () => void = () => {},
): Promise<string> {
  if (!stream) return "";
  const decoder = new TextDecoder();
  let raw = "";
  let rest = "";
  const say = (raw: string): void => {
    const line = (raw.includes("\r") ? raw.slice(raw.lastIndexOf("\r") + 1) : raw).trimEnd();
    if (line) log.plain(line);
  };
  for await (const chunk of stream) {
    activity();
    const text = decoder.decode(chunk as Uint8Array, { stream: true });
    raw += text;
    rest += text;
    // curl, mise and several archive tools redraw download progress with a
    // carriage return and do not send a newline until they finish. Waiting for
    // `\n` made an active Ubuntu install look frozen for the whole download.
    // A chunk may contain several redraws, so publish only its newest state:
    // this stays live between chunks without filling the log with 10/11/12%.
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) say(line);
    if (rest.includes("\r")) {
      const redraws = rest.split("\r");
      rest = redraws.pop() ?? "";
      say(redraws.at(-1) ?? "");
    }
  }
  const final = decoder.decode();
  raw += final;
  rest += final;
  say(rest);
  return raw;
}

/** Stream both child outputs through the logger and retain them for classification. */
export async function spawnLoggedCapture(
  cmd: string[],
  extra: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    /** Test seam; production uses the shared five-second cadence. */
    heartbeatMs?: number;
  } = {},
): Promise<{ code: number; out: string; err: string }> {
  const { env, heartbeatMs, ...spawnOptions } = extra;
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: providerStdinMode(),
    ...spawnOptions,
    env: unattendedEnvironment(process.env, env),
  });
  const heartbeat = startProcessHeartbeat(cmd, heartbeatMs);
  try {
    const [out, err, code] = await Promise.all([
      pumpToLog(proc.stdout, heartbeat.activity),
      pumpToLog(proc.stderr, heartbeat.activity),
      proc.exited,
    ]);
    return { code, out, err };
  } finally {
    heartbeat.stop();
  }
}

/**
 * Spawn a child and put its output where log output is going.
 *
 * Inheriting is right when the terminal *is* the interface: the child's
 * output is the feedback, unbuffered and in real time. It is wrong
 * inside the fullscreen one, where the renderer owns the screen and a
 * child writes wherever the cursor happens to be — which is how a line
 * of installer output ended up painted through the middle of the
 * right-hand column on a 96-column window.
 *
 * stdin is always detached, independently of output routing. The caller has
 * already made every product choice; a provider opening its own prompt is a
 * failure, not a second interactive interface hidden inside the first.
 */
export async function spawnLogged(
  cmd: string[],
  extra: {
    env?: Record<string, string | undefined>;
    cwd?: string;
    heartbeatMs?: number;
  } = {},
): Promise<number> {
  if (!logIsCaptured()) {
    const { env, heartbeatMs, ...spawnOptions } = extra;
    const proc = Bun.spawn(cmd, {
      stdout: "inherit",
      stderr: "inherit",
      stdin: providerStdinMode(),
      ...spawnOptions,
      env: unattendedEnvironment(process.env, env),
    });
    // Inherited output cannot be observed here, so do not claim it has been
    // silent. The elapsed heartbeat still proves the child is alive.
    const heartbeat = startProcessHeartbeat(cmd, heartbeatMs, false);
    try {
      return await proc.exited;
    } finally {
      heartbeat.stop();
    }
  }

  return (await spawnLoggedCapture(cmd, extra)).code;
}

/** Keep Git's POSIX utilities visible when a caller supplies Windows PATH. */
export function windowsInstallerEnvironment(
  shell: string,
  current: Record<string, string | undefined>,
  platform: string = process.platform,
): Record<string, string | undefined> {
  if (platform !== "win32") return current;
  const match = /^(.*)[\\/]bin[\\/]bash(?:\.exe)?$/i.exec(shell);
  if (!match?.[1]) return current;
  const utilities = `${match[1]}\\usr\\bin`;
  const inherited = current["Path"] ?? current["PATH"] ?? "";
  const entries = inherited.split(";");
  const path = entries.some((entry) => entry.toLowerCase() === utilities.toLowerCase())
    ? inherited
    : `${utilities};${inherited}`;
  return { ...current, Path: path, PATH: path };
}

async function run(
  cmd: string[],
  opts: { allowFailure?: boolean } = {},
): Promise<number> {
  const code = await spawnLogged(cmd);
  if (code !== 0 && !opts.allowFailure) {
    throw new RedError(`${cmd[0]} exited ${code}: ${cmd.join(" ")}`);
  }
  return code;
}

async function capture(cmd: string[]): Promise<string> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

// ------------------------------------------------------------- apt

let aptRefreshed = false;
let sudoChecked = false;

/**
 * Fail fast when sudo would block on a password prompt.
 *
 * Detaching stdin is not enough: WSL hands even a non-interactive
 * `wsl -- bash -lc` a pty, so isTTY is true, sudo prompts, and the run
 * sits there forever against a terminal nobody is watching. `sudo -n`
 * answers "would this block?" without blocking, which turns a hang
 * into one line telling the user what to do.
 */
export async function requireSudo(): Promise<void> {
  if (sudoChecked) return;
  if (process.getuid?.() === 0) {
    sudoChecked = true;
    return;
  }

  const probe = Bun.spawn(["sudo", "-n", "true"], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: "ignore",
  });
  // The wording lives in rights.ts, where the Windows sibling of this
  // refusal lives too. Same bytes as before — this branch is where the
  // shared classification came from, not somewhere it was applied.
  if ((await probe.exited) !== 0) {
    throw new RedError(missingRights("sudo").message);
  }
  sudoChecked = true;
}

export async function aptRefreshOnce(): Promise<void> {
  if (aptRefreshed) return;
  await requireSudo();
  log.step("apt-get update");
  await run(["sudo", "-E", "apt-get", "update", "-y"]);
  aptRefreshed = true;
}

/**
 * Batched on purpose. Twenty sequential apt-get calls is the single
 * slowest part of a fresh provision, and each one re-reads the package
 * lists.
 */
export async function aptInstall(pkgs: string[]): Promise<void> {
  if (pkgs.length === 0) return;
  await aptRefreshOnce();
  log.step(`apt: ${pkgs.join(" ")}`);
  log.info(
    pkgs.length === 1
      ? `one package, from the archive apt is already configured with`
      : `${pkgs.length} packages in one transaction, from the configured archives`,
  );
  const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
  const code = await spawnLogged(["sudo", "-E", "apt-get", "install", "-y", ...pkgs], { env });
  if (code !== 0) throw new RedError(`apt-get install failed (${code})`);
}

// ---------------------------------------------------------- winget

/**
 * Build the argv that actually runs winget.
 *
 * winget is an APPEXECLINK reparse point under WindowsApps, and a
 * process cannot exec one directly — not by name, and not by absolute
 * path either, which is the part that took three attempts to learn.
 * Bun's spawn reports "Executable not found in $PATH" even when handed
 * the exact path `where.exe` returns.
 *
 * cmd.exe resolves execution aliases the way Explorer does, so going
 * through it is the difference between every winget install failing and
 * every one working. Under WSL the same alias is reached through the
 * interop layer, where winget.exe is a normal executable again.
 *
 * This is the third face of the same reparse-point problem: detection
 * needed where.exe, the font install needed AddFontResourceW, and
 * execution needs cmd.exe.
 */
export function wingetArgv(args: string[], platform: string = process.platform): string[] {
  if (platform === "win32") {
    return ["cmd.exe", "/c", "winget", ...args];
  }
  return [Bun.which("winget.exe") ?? "winget.exe", ...args];
}

export async function wingetInstall(id: string): Promise<void> {
  log.step(`winget: ${id}`);
  // winget downloads, hashes and verifies the installer against the
  // manifest itself, and refuses to install when they disagree — so
  // there is nothing for this project to hash. Said out loud, because
  // "no sha256 line here" otherwise reads as a gap.
  log.info(`winget verifies the package hash against its own manifest`);

  // Captured rather than inherited so the outcome can be read. winget
  // signals "installed, nothing to upgrade" with a non-zero code, and
  // treating every non-zero as a warning turns the steady state of an
  // idempotent converge into something that reads like a problem —
  // right underneath winget's own line saying it is fine.
  const result = await spawnLoggedCapture(
    wingetArgv([
      "install",
      "--id",
      id,
      "--exact",
      "--silent",
      "--accept-package-agreements",
      "--accept-source-agreements",
      // Piping stdout is not enough to keep winget off the screen.
      // Its progress UI is drawn with the Windows console API against
      // CONOUT$, which ignores a redirected stdout entirely — so inside
      // the fullscreen converge it painted through the right-hand panel:
      //
      //   Elapsed
      //   4m 48sinformation on key differences w
      //
      // --disable-interactivity turns that UI off and leaves the plain
      // lines, which the pipe does capture.
      "--disable-interactivity",
    ]),
  );
  const out = result.out + result.err;
  const { code } = result;

  if (code === 0) return;

  if (/No available upgrade found|already installed|No newer package versions/i.test(out)) {
    log.skip(`${id} already current`);
    return;
  }

  // Everything else is a failure and has to be reported as one.
  //
  // This used to warn and return, so a converge that could not install
  // anything still reported success. A mistyped id is the case that
  // matters: winget exits 20 with "No package found matching input
  // criteria", and `JesseDuffield.lazydocker` — lowercase L, where the
  // real package is `Lazydocker` — sat in the manifest being reported
  // as installed. A silent wrong result is worse than a loud failure.
  const detail = out.trim().split("\n").filter(Boolean).slice(-2).join(" ").trim();
  throw new RedError(
    /No package found/i.test(out)
      ? `winget has no package '${id}' — check the exact id, it is case-sensitive`
      : `winget exited ${code} for ${id}${detail ? `: ${detail}` : ""}`,
  );
}

/**
 * How long a release download may take before it is a failure.
 *
 * Ninety seconds is generous for the largest asset here (33 MB, which
 * curl pulls in one second) and short enough that a wedged step is
 * something you watch fail rather than something you kill.
 */
const DOWNLOAD_TIMEOUT_MS = 90_000;

// ------------------------------------------------ verified download

export interface DownloadOptions {
  /** The publisher's own checksum file, when the release has one. */
  checksumUrl?: string | null;
  /** Injected by tests. The product always uses the global fetch. */
  fetcher?: typeof fetch;
  /** Injected by tests, so a download can be asserted without a disk. */
  write?: (path: string, bytes: Uint8Array) => Promise<unknown>;
  timeoutMs?: number;
  /** Test seam; production uses the shared five-second cadence. */
  heartbeatMs?: number;
}

interface ObservedFetchOptions {
  fetcher?: typeof fetch;
  init?: RequestInit;
  timeoutMs: number;
  heartbeatMs?: number;
}

/** Fetch headers and body while keeping network silence visible. */
async function fetchObservedBytes(
  url: string,
  opts: ObservedFetchOptions,
): Promise<{ response: Response; body: Uint8Array }> {
  const heartbeat = startProcessHeartbeat(
    ["fetch"],
    opts.heartbeatMs,
    true,
    "no response data for",
  );
  try {
    const response = await (opts.fetcher ?? fetch)(url, {
      ...opts.init,
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
    heartbeat.activity();
    if (!response.body) return { response, body: new Uint8Array() };

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      heartbeat.activity();
      chunks.push(next.value);
      size += next.value.byteLength;
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { response, body };
  } finally {
    heartbeat.stop();
  }
}

function requestTimedOut(err: unknown): boolean {
  return (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
}

/**
 * Read a publisher's checksum file and find our asset's line in it.
 *
 * Every disappointment here is a warning, never a failure. A release
 * that stopped publishing checksums, a checksums file behind a rate
 * limit, an asset the file does not mention — none of those are evidence
 * that the download is wrong, and refusing to install over them would
 * make the strength of the check depend on GitHub's mood.
 */
async function publishedChecksum(
  url: string,
  file: string,
  fetcher: typeof fetch,
  timeoutMs: number,
): Promise<string | null> {
  const name = url.split("/").pop() ?? url;
  log.info(`published checksums: ${name}`);
  try {
    const { response: res, body } = await fetchObservedBytes(url, { fetcher, timeoutMs });
    if (!res.ok) {
      log.warn(`could not read ${name} (${res.status})`);
      return null;
    }
    const hash = parseChecksums(new TextDecoder().decode(body), file);
    if (!hash) log.warn(`${name} has no entry for ${file}`);
    return hash;
  } catch (err) {
    log.warn(`could not read ${name} (${(err as Error).name})`);
    return null;
  }
}

/**
 * Fetch a file, say what came back, hash it, and only then write it.
 *
 * The order is the point. Verifying after writing leaves a rejected
 * asset sitting in a temp directory that the next branch is about to
 * unpack; verifying before it means a mismatch cannot be installed by a
 * later line that forgot to check.
 *
 * The body is read whole before writing for the reason the download
 * timeout exists at all: `Bun.write(path, response)` never returned for
 * a 33 MB asset, with no child process and no error, and a converge sat
 * there forever.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  opts: DownloadOptions = {},
): Promise<{ sha256: string; bytes: number }> {
  const fetcher = opts.fetcher ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const file = url.split("/").pop() ?? "asset";

  log.info(`downloading ${url}`);
  log.info(`saving to ${dest}`);

  const started = Date.now();
  const fetched = await fetchObservedBytes(url, {
    fetcher,
    timeoutMs,
    heartbeatMs: opts.heartbeatMs,
  }).catch(
    (err: unknown) => {
      throw new RedError(
        requestTimedOut(err)
          ? `download did not finish within ${timeoutMs / 1000}s: ${url}`
          : `download failed: ${url} (${(err as Error).message})`,
      );
    },
  );
  const { response: res, body } = fetched;
  if (!res.ok) throw new RedError(`download failed ${res.status}: ${url}`);
  log.info(`received ${formatBytes(body.byteLength)} in ${formatDuration(Date.now() - started)}`);

  const digest = sha256Hex(body);
  log.info(`sha256 ${digest}`);
  const expected = opts.checksumUrl
    ? await publishedChecksum(opts.checksumUrl, file, fetcher, timeoutMs)
    : null;
  verifyChecksum(file, digest, expected);

  await (opts.write ?? ((path: string, bytes: Uint8Array) => Bun.write(path, bytes)))(dest, body);
  return { sha256: digest, bytes: body.byteLength };
}

// --------------------------------------------------- github release

/**
 * Exported for tests: asset matching is where a silent bug costs most.
 * Case-insensitive because upstreams rename freely — lazygit 0.64.0
 * turned `Linux_x86_64` into `linux_x86_64` and the column went dark.
 */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}

/**
 * Which release to ask for: the newest, or one named tag.
 *
 * Exported and separate from the fetch so the choice can be asserted
 * without a network — the pin is worth nothing if this silently keeps
 * resolving /latest, and that is a failure no unit test would see if the
 * URL were built inline.
 */
export function releaseApiUrl(repo: string, version?: string): string {
  const which = version ? `tags/${version}` : "latest";
  return `https://api.github.com/repos/${repo}/releases/${which}`;
}

/**
 * Resolve a release asset by matching a glob against the names the
 * release actually publishes. Never construct the filename from a
 * pinned version — see the note on the `gh` provider in manifest.ts.
 *
 * `version` names a tag to hold to; without it this is /releases/latest,
 * which is what every unpinned tool still gets.
 */
export interface GhRelease {
  /** The tag the release is published under, as the publisher wrote it. */
  tag: string;
  /** Where the matched asset is downloaded from. */
  url: string;
  /** The asset's own filename. */
  file: string;
  /**
   * The asset carrying this file's sha256, when the release has one.
   *
   * Resolved here rather than by the caller because this is the only
   * place holding the whole asset list — reconstructing a checksum
   * filename from a convention is exactly the guess that the asset glob
   * exists to stop making.
   */
  checksumUrl: string | null;
}

export async function resolveGhAsset(
  repo: string,
  glob: string,
  version?: string,
): Promise<string> {
  return (await resolveGhRelease(repo, glob, version)).url;
}

export async function resolveGhRelease(
  repo: string,
  glob: string,
  version?: string,
): Promise<GhRelease> {
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = process.env["GITHUB_TOKEN"];
  if (token) headers["Authorization"] = `Bearer ${token}`;

  // The same deadline the download has, and for a sharper reason: this
  // is where a converge actually stopped. `red` printed its step header
  // and nothing else — never even the "github: …" line, which is logged
  // after this call returns — so the API request was where it sat, with
  // no child process to notice and no error to report.
  const fetched = await fetchObservedBytes(releaseApiUrl(repo, version), {
    init: { headers },
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
  }).catch((err: unknown) => {
    throw new RedError(
      requestTimedOut(err)
        ? `GitHub API did not answer within ${DOWNLOAD_TIMEOUT_MS / 1000}s for ${repo}`
        : `GitHub API failed for ${repo} (${(err as Error).message})`,
    );
  });
  const { response: res, body: responseBody } = fetched;
  if (!res.ok) {
    throw new RedError(
      `GitHub API ${res.status} for ${repo}` +
        // A pinned tag has a failure of its own: 404 here means the tag
        // does not exist, usually because it was written as a version
        // when the publisher prefixes with `v`. Saying which tag was
        // asked for is the difference between a one-line fix and a hunt.
        (version && res.status === 404 ? ` — no release tagged '${version}'` : "") +
        (res.status === 403 ? " — rate limited, set GITHUB_TOKEN" : ""),
    );
  }

  const body = JSON.parse(new TextDecoder().decode(responseBody)) as {
    assets?: GhAsset[];
    tag_name?: string;
  };
  const assets = body.assets ?? [];
  const re = globToRegExp(glob);
  const hit = assets.find((a) => re.test(a.name));

  if (!hit) {
    const available = assets.map((a) => `  ${a.name}`).join("\n");
    throw new RedError(
      `no asset matching '${glob}' in ${version ?? "latest"} ${repo} release.\nAvailable:\n${available}`,
    );
  }

  const checksum = pickChecksumAsset(
    assets.map((a) => a.name),
    hit.name,
  );
  return {
    tag: body.tag_name ?? version ?? "latest",
    url: hit.browser_download_url,
    file: hit.name,
    checksumUrl: checksum
      ? (assets.find((a) => a.name === checksum)?.browser_download_url ?? null)
      : null,
  };
}

export async function ghInstall(
  repo: string,
  glob: string,
  bin?: string,
  version?: string,
): Promise<void> {
  const release = await resolveGhRelease(repo, glob, version);
  const { url, file } = release;
  log.step(`github: ${repo} -> ${file}`);
  log.info(`release ${release.tag}${version ? " (pinned)" : " (latest)"} of ${repo}`);

  // tempDir, not /tmp and mkdir: on native Windows /tmp is not the
  // directory a spawned shell resolves, and there is no mkdir binary.
  const tmp = tempDir(`gh-${Date.now()}`);

  // A download with no deadline can wedge a converge forever, and one
  // did: `red` stopped at step 13 with no child process, no output and
  // no end. Whatever the cause — and it is still unexplained, the same
  // asset fetches in a second with curl — a step that cannot finish
  // must at least be able to fail. One tool failing never aborts the
  // rest; one tool hanging aborts everything.
  await downloadVerified(url, `${tmp}/${file}`, { checksumUrl: release.checksumUrl });

  if (file.endsWith(".deb")) {
    // The only branch that genuinely needs it: dpkg writes system-wide
    // and there is no user-level equivalent.
    log.info(`installing the .deb with apt-get (needs sudo)`);
    await requireSudo();
    // -E is not cosmetic: without it sudo discards the unattended envelope
    // before apt launches dpkg and its maintainer scripts.
    await run(["sudo", "-E", "apt-get", "install", "-y", `${tmp}/${file}`]);
  } else if (file.endsWith(".tar.gz") || file.endsWith(".tgz")) {
    log.info(`extracting the archive into ${tmp}`);
    await run(["tar", "-xzf", `${tmp}/${file}`, "-C", tmp]);
    await installBinariesFrom(tmp);
  } else if (file.endsWith(".zip")) {
    log.info(`extracting the archive into ${tmp}`);
    await run(["unzip", "-qo", `${tmp}/${file}`, "-d", tmp]);
    await installBinariesFrom(tmp);
  } else if (bin) {
    // A bare binary. Several projects publish one rather than an
    // archive, and its asset name usually encodes the platform rather
    // than the command, so the caller names it.
    const dir = userBinDir();
    log.info(`bare binary — installing it as ${dir}/${bin}`);
    mkdirSync(dir, { recursive: true });
    await run(["chmod", "+x", `${tmp}/${file}`]);
    await run(["install", "-m", "0755", `${tmp}/${file}`, `${dir}/${bin}`]);
    log.ok(`installed ${dir}/${bin}`);
  } else {
    throw new RedError(
      `don't know how to unpack ${file} — if it is a bare binary, give the provider a bin name`,
    );
  }

  removeTemp(tmp);
}

/**
 * A stable release asset whose filename is known exactly.
 *
 * GitHub serves this redirect from github.com rather than the REST API, so a
 * fresh machine cannot spend an anonymous API quota merely discovering a name
 * already declared in our catalog. RedCode owns its asset contract, making an
 * exact URL both cheaper and stricter than resolving a glob through /latest.
 */
export function exactGhReleaseUrl(repo: string, asset: string, tag = "latest"): string {
  const release = tag === "latest" ? "latest/download" : `download/${tag}`;
  return `https://github.com/${repo}/releases/${release}/${asset}`;
}

function findNamedFile(root: string, wanted: string): string | null {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = `${root}/${entry.name}`;
    if (entry.isDirectory()) {
      const nested = findNamedFile(path, wanted);
      if (nested) return nested;
    } else if (entry.name.toLowerCase() === wanted.toLowerCase()) {
      return path;
    }
  }
  return null;
}

/** Install one exact archive asset without consulting the GitHub API. */
export async function ghInstallExactArchive(
  repo: string,
  asset: string,
  bin: string,
  p: Platform,
  tag = "latest",
): Promise<void> {
  const url = exactGhReleaseUrl(repo, asset, tag);
  const tmp = tempDir(`gh-exact-${Date.now()}`);
  const downloaded = `${tmp}/${asset}`;
  log.step(`github: ${repo} -> ${asset}`);
  log.info(`${tag === "latest" ? "stable release redirect" : `release ${tag}`} — no GitHub API lookup`);
  await downloadVerified(url, downloaded);

  if (asset.endsWith(".tar.gz") || asset.endsWith(".tgz")) {
    log.info(`extracting ${asset}`);
    await run(["tar", "-xzf", downloaded, "-C", tmp]);
  } else if (asset.endsWith(".zip") && p.os === "windows") {
    log.info(`extracting ${asset} with Windows PowerShell`);
    await run([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      downloaded,
      tmp,
    ]);
  } else if (asset.endsWith(".zip")) {
    log.info(`extracting ${asset}`);
    await run(["unzip", "-qo", downloaded, "-d", tmp]);
  } else {
    removeTemp(tmp);
    throw new RedError(`exact GitHub asset must be an archive: ${asset}`);
  }

  const filename = p.os === "windows" ? `${bin}.exe` : bin;
  const source = findNamedFile(tmp, filename);
  if (!source) {
    removeTemp(tmp);
    throw new RedError(`${asset} did not contain ${filename}`);
  }
  const dir = p.os === "windows" ? windowsBinDir() : userBinDir();
  const target = `${dir}/${filename}`;
  mkdirSync(dir, { recursive: true });
  copyFileSync(source, target);
  if (p.os !== "windows") chmodSync(target, 0o755);
  log.ok(`installed ${target}`);
  removeTemp(tmp);
}

/**
 * The same release, onto Windows.
 *
 * Neither of the two RedDB tools is on winget, and every other `gh`
 * entry in the manifest falls back to a winget id — so without this the
 * only honest Windows column for them would be skip(), on a target
 * where the publisher does ship a build. That is precisely the gap this
 * project exists to close.
 *
 * No sudo equivalent and no admin: a bare binary lands in the same
 * per-user bin directory boot.ps1 already created and put on PATH, and
 * an installer is the vendor's own, run with the flags it documents.
 */
export async function ghInstallWindows(
  repo: string,
  glob: string,
  bin?: string,
  silentArgs?: string[],
  version?: string,
): Promise<void> {
  const release = await resolveGhRelease(repo, glob, version);
  const { url, file } = release;
  log.step(`github: ${repo} -> ${file}`);
  log.info(`release ${release.tag}${version ? " (pinned)" : " (latest)"} of ${repo}`);

  // node:fs rather than cmd.exe for the file work. `mkdir` and `copy`
  // print "A subdirectory or file already exists." and "1 file(s)
  // copied." on success, and both landed in the middle of the converge
  // log — chatter from a shell we only invoked because it was the first
  // thing to hand.
  const tmp = `${process.env["TEMP"] ?? "C:\\Windows\\Temp"}\\red-dev-${Date.now()}`;
  mkdirSync(tmp, { recursive: true });
  const downloaded = `${tmp}\\${file}`;

  // Same as the Linux path, and through the same helper: the download,
  // the hash and the comparison against the published checksum must not
  // be two implementations that can disagree about what verified means.
  await downloadVerified(url, downloaded, { checksumUrl: release.checksumUrl });

  if (silentArgs) {
    // An installer, run the way its publisher documents. Verified
    // against the asset rather than assumed: red-request's is NSIS and
    // its PE manifest asks for asInvoker, so /S installs per-user with
    // no UAC prompt — which is what lets a converge stay unattended.
    log.step(`running ${file} ${silentArgs.join(" ")}`);
    await run([downloaded, ...silentArgs]);
  } else if (bin) {
    const dir = windowsBinDir();
    log.info(`bare binary — installing it as ${dir}\\${bin}.exe`);
    mkdirSync(dir, { recursive: true });
    // Copied rather than moved: the download and the destination can be
    // on different volumes, where a rename fails.
    copyFileSync(downloaded, `${dir}\\${bin}.exe`);
    log.ok(`installed ${dir}\\${bin}.exe`);
  } else {
    throw new RedError(
      `don't know what to do with ${file} on Windows — give the provider a bin name, or silentArgs if it is an installer`,
    );
  }

  rmSync(tmp, { recursive: true, force: true });
}

/**
 * Where boot.ps1 puts red-dev, and therefore somewhere already on the
 * user's PATH. Anything installed beside it is reachable without a
 * second PATH entry to explain.
 */
export function windowsBinDir(): string {
  const override = process.env["RED_DEV_BIN_DIR"];
  if (override) return override;
  const local = process.env["LOCALAPPDATA"];
  if (!local) throw new RedError("LOCALAPPDATA is not set — cannot place a binary");
  return `${local}\\red-dev\\bin`;
}

/**
 * Where a binary goes when nothing forces it system-wide.
 *
 * ~/.local/bin, and the reason it is not /usr/local/bin is that the
 * latter bought nothing and cost a password. Every gh install called
 * requireSudo before doing anything, so installing tq inside the
 * fullscreen converge failed with "sudo needs a password and nothing
 * here can supply one" — a prompt has nowhere to appear when a render
 * owns the screen.
 *
 * The directory is already first on the PATH red-dev builds, it is what
 * red-dev installs *itself* into, and it is where herdr's own installer
 * puts its binary. A tool one user runs does not belong to root.
 */
export function userBinDir(): string {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  return `${home}/.local/bin`;
}

async function installBinariesFrom(dir: string): Promise<void> {
  const dest = userBinDir();
  mkdirSync(dest, { recursive: true });
  const listing = await capture([
    "find",
    dir,
    "-type",
    "f",
    "-perm",
    "-u+x",
    "-not",
    "-name",
    "*.tar.gz",
    "-not",
    "-name",
    "*.zip",
  ]);
  for (const path of listing.split("\n").filter(Boolean)) {
    const base = path.split("/").pop() ?? "";
    if (/\.(md|txt)$/i.test(base) || /^(LICENSE|README)/i.test(base)) continue;
    await run(["install", "-m", "0755", path, `${dest}/`]);
    log.ok(`installed ${dest}/${base}`);
  }
}

// -------------------------------------------------------------- npm

/**
 * Fetch a vendor's install script and run it.
 *
 * Downloaded to a file and executed, rather than piped into sh: a pipe
 * consumes stdin, so an installer that wants to ask something gets EOF
 * instead — and a truncated download runs whatever prefix arrived.
 * Writing it out first means a failed transfer fails before anything
 * executes.
 */
/**
 * Which shell a vendor script asked for.
 *
 * `#!/usr/bin/env bash` counts as bash, which is the form dit uses —
 * matching only `#!/bin/bash` would have sent it to dash anyway.
 * Anything else falls back to sh, because a script that does not say is
 * a script that should not need more than POSIX.
 */
export function shellFor(body: string): "bash" | "sh" {
  const m = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(body);
  if (!m?.[1]) return "sh";
  const interpreter = m[1].endsWith("/env") && m[2] ? m[2] : m[1];
  return /(^|\/)bash$/.test(interpreter) ? "bash" : "sh";
}

/**
 * The shell binary to actually spawn, which on Windows is not `bash`.
 *
 * `bash` on a Windows PATH is usually C:\Windows\System32\bash.exe — the
 * WSL launcher. It runs inside the distro, where a Windows path means
 * nothing, so handing it a script under %LOCALAPPDATA%\Temp produced
 *
 *   /bin/bash: C:/Users/filip/AppData/Local/Temp/red-dev-installer-N.sh:
 *   No such file or directory
 *
 * which reads like the temp path being wrong a second time. It was not:
 * the file was there, and the interpreter was standing in another
 * filesystem.
 *
 * Git Bash is the one that shares a filesystem with this process. Named
 * by absolute path rather than found on PATH, because the whole problem
 * is that PATH answers `bash` with the wrong one.
 *
 * Returns null when neither is present, so the caller can say what is
 * missing instead of spawning something that will fail confusingly.
 */
export function windowsShellPath(name: "bash" | "sh"): string | null {
  const candidates = [
    `C:\\Program Files\\Git\\bin\\${name}.exe`,
    `C:\\Program Files (x86)\\Git\\bin\\${name}.exe`,
    `C:\\Program Files\\Git\\usr\\bin\\${name}.exe`,
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export async function installerInstall(
  url: string,
  note: string,
  args: string[] = [],
  env?: Record<string, string | undefined>,
  network: { heartbeatMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  log.step(`installer: ${url}`);
  log.plain(`       ${note}`);

  // A path the writer and the interpreter agree on.
  //
  // This was `/tmp/red-dev-installer-N.sh`, which is two different
  // directories on native Windows: the Bun process writes it to C:\tmp,
  // and Git Bash resolves /tmp to %LOCALAPPDATA%\Temp. So bash was
  // handed a path to a file that, from where it was standing, did not
  // exist:
  //
  //   /bin/bash: /tmp/red-dev-installer-1786098097590.sh: No such file
  //
  // os.tmpdir() gives the real directory on both, and forward slashes
  // with a drive letter — C:/Users/.../Temp/x.sh — is a spelling Git
  // Bash accepts and Bun writes to correctly.
  const tmp = tempFile(`installer-${Date.now()}.sh`);
  log.info(`fetching the vendor script from ${url}`);
  log.info(`saving to ${tmp}`);
  const timeoutMs = network.timeoutMs ?? DOWNLOAD_TIMEOUT_MS;
  const fetched = await fetchObservedBytes(url, {
    timeoutMs,
    heartbeatMs: network.heartbeatMs,
  }).catch((err: unknown) => {
    throw new RedError(
      requestTimedOut(err)
        ? `installer download did not finish within ${timeoutMs / 1000}s: ${url}`
        : `installer download failed: ${url} (${(err as Error).message})`,
    );
  });
  const { response: res, body: responseBody } = fetched;
  if (!res.ok) throw new RedError(`installer download failed ${res.status}: ${url}`);
  const body = new TextDecoder().decode(responseBody);
  if (body.trim().length === 0) throw new RedError(`installer at ${url} was empty`);
  // A vendor script publishes no checksum anywhere this can reach, so
  // the hash is a record rather than a comparison — which is still the
  // only way to tell afterwards that two machines ran the same script.
  const script = new TextEncoder().encode(body);
  log.info(`received ${formatBytes(script.byteLength)} of shell`);
  verifyChecksum(url, sha256Hex(script), null);
  await Bun.write(tmp, body);

  // Run with the interpreter the script asks for, not with `sh`.
  //
  // red-request's installer is deliberately POSIX and says so in its
  // header; dit's is `#!/usr/bin/env bash` and uses `[[ ]]` and `local`
  // in its input-permission setup. On Ubuntu `sh` is dash, so running
  // every vendor script through it would have failed that one with a
  // syntax error partway through — after it had already installed the
  // binary, which is the worst place to stop.
  const want = shellFor(body);

  // On Windows, resolve to the shell that can see this file. See
  // windowsShellPath: `bash` on PATH there is the WSL launcher, which
  // runs in another filesystem entirely.
  const shell = process.platform === "win32" ? windowsShellPath(want) : want;
  if (!shell) {
    throw new RedError(
      `${url} is a ${want} script and there is no Git Bash to run it.\n` +
        "      Install Git for Windows, or use the WSL side.",
    );
  }

  // Primed before handing over, not after it blocks.
  //
  // A vendor script that installs a .deb calls sudo from inside itself,
  // where none of our own guards apply — so an unprimed timestamp turns
  // into a password prompt against a converge whose output the TUI is
  // capturing. requireSudo answers "would this block?" without blocking
  // and fails with an instruction instead.
  // Not on native Windows, where there is no sudo to prime and asking
  // for one threw `Executable not found in $PATH: "sudo"` — a message
  // about red-dev's own guard, reported as the vendor script failing.
  // A script that genuinely needs root cannot run here regardless; that
  // is a reason to not reach this function, which installAgent now
  // handles by preferring npm on Windows.
  const usesSudo = process.platform !== "win32" && body.includes("sudo ");
  if (usesSudo) await requireSudo();

  log.info(`running it with ${shell}${args.length > 0 ? ` ${args.join(" ")}` : ""}`);
  let installerEnv = unattendedEnvironment(process.env, env);
  let sudoShim: string | null = null;

  // An installer child inherits our variables, but an internal `sudo apt`
  // normally erases them before dpkg and maintainer scripts start. Put a
  // private shim first on PATH for the audited vendor script: it delegates to
  // the real sudo with -E, preserving exactly the envelope we supplied. The
  // password itself was already handled visibly by the top-level preflight.
  if (usesSudo) {
    const realSudo = Bun.which("sudo");
    if (realSudo) {
      sudoShim = tempDir(`sudo-env-${Date.now()}`);
      const wrapper = `${sudoShim}/sudo`;
      const quoted = `'${realSudo.replace(/'/g, `'"'"'`)}'`;
      await Bun.write(wrapper, `#!/bin/sh\nexec ${quoted} -E "$@"\n`);
      chmodSync(wrapper, 0o700);
      installerEnv = {
        ...installerEnv,
        PATH: `${sudoShim}:${installerEnv["PATH"] ?? ""}`,
      };
    }
  }

  const childEnv = windowsInstallerEnvironment(shell, installerEnv);
  const result = await spawnLoggedCapture([shell, tmp, ...args], { env: childEnv });
  if (sudoShim) removeTemp(sudoShim);
  // node:fs, not `rm`. There is no rm on native Windows, so cleaning up
  // failed with `Executable not found in $PATH: "rm"` — reported as the
  // installer's own failure, which sent the reader looking at the vendor
  // script instead of at this line.
  removeTemp(tmp);

  if (result.code !== 0) {
    throw new RedError(
      tlsTrustFailure(result.out + result.err) ?? `installer exited ${result.code}: ${url}`,
    );
  }
}

// ------------------------------------------------- ppa / apt repos

export async function ppaInstall(ppa: string, pkgs: string[]): Promise<void> {
  await requireSudo();
  log.step(`ppa: ${ppa}`);
  log.info(`adding ppa:${ppa}, then installing ${pkgs.join(" ")} from it`);
  // add-apt-repository refreshes the lists itself, but only for the
  // repository it just added; the batched refresh still has to happen.
  await run(["sudo", "-E", "add-apt-repository", "-y", `ppa:${ppa}`]);
  aptRefreshed = false;
  await aptInstall(pkgs);
}

/**
 * Which file under sources.list.d already configures this repository,
 * if any. Both the one-line .list format and the deb822 .sources format
 * are checked, because Ubuntu 24.04 onward writes the latter.
 */
async function findSourceFor(repoUrl: string): Promise<string | null> {
  const dir = "/etc/apt/sources.list.d";
  if (!existsSync(dir)) return null;
  const listing = await capture(["sh", "-c", `grep -rl "${repoUrl}" ${dir} 2>/dev/null || true`]);
  const first = listing.split("\n").find(Boolean);
  return first ?? null;
}

export interface AptRepoSpec {
  pkgs: string[];
  keyUrl: string;
  keyring: string;
  entry: string;
  group?: string;
}

/**
 * Add a third-party apt repository and install from it.
 *
 * The key is fetched and dearmored only if it is not already present,
 * and the sources entry is written only if its content differs, so a
 * re-run touches nothing. That matters: apt refuses to work at all when
 * the same repository is configured twice.
 */
export async function aptRepoInstall(
  spec: AptRepoSpec,
  codename: string,
): Promise<void> {
  const entry = spec.entry.replaceAll("{{codename}}", codename);
  const listName = spec.keyring.split("/").pop()?.replace(/\.(gpg|asc)$/, "") ?? "red-dev";
  const listPath = `/etc/apt/sources.list.d/${listName}.list`;

  if (!existsSync(spec.keyring)) {
    log.step(`key: ${spec.keyUrl}`);
    await run(["sudo", "install", "-m", "0755", "-d", "/etc/apt/keyrings"]);
    const tmp = `/tmp/red-dev-key-${listName}`;
    // Through the same helper as every other download, so the signing
    // key gets the same line of provenance the assets do. No publisher
    // here ships a checksum for it — the key *is* the trust anchor, and
    // apt verifies every package against it afterwards.
    await downloadVerified(spec.keyUrl, tmp);

    // .asc keys are armoured text and apt reads them directly; .gpg
    // must be binary, so dearmor when the target says so.
    if (spec.keyring.endsWith(".gpg")) {
      await run(["sudo", "sh", "-c", `gpg --dearmor < "${tmp}" > "${spec.keyring}"`]);
    } else {
      await run(["sudo", "cp", tmp, spec.keyring]);
    }
    await run(["sudo", "chmod", "a+r", spec.keyring]);
    await run(["rm", "-f", tmp], { allowFailure: true });
  }

  // Someone else may already have configured this repository under a
  // different filename — omakub writes github-cli.list where we would
  // write githubcli-archive-keyring.list. Adding ours too makes apt
  // complain about a duplicate source on every single invocation, so
  // look for the URL anywhere under sources.list.d before writing.
  const repoUrl = /https?:\/\/\S+/.exec(entry)?.[0] ?? "";
  const existingOwner = repoUrl ? await findSourceFor(repoUrl) : null;

  if (existingOwner && existingOwner !== listPath) {
    log.skip(`repository already configured in ${existingOwner}`);
  } else {
    const current = existsSync(listPath) ? await Bun.file(listPath).text() : "";
    if (current.trim() !== entry.trim()) {
      log.step(`repo: ${listPath}`);
      log.info(entry);
      await run(["sudo", "sh", "-c", `printf '%s\\n' "${entry}" > "${listPath}"`]);
      aptRefreshed = false;
    }
  }

  await aptInstall(spec.pkgs);

  if (spec.group) {
    const user = process.env["USER"] ?? process.env["LOGNAME"];
    if (user) {
      await run(["sudo", "usermod", "-aG", spec.group, user], { allowFailure: true });
      log.ok(`${user} added to group '${spec.group}' — log out and back in to take effect`);
    }
  }
}

// -------------------------------------------------------- updates

/**
 * Update everything the platform's own package manager owns. Kept
 * separate from `install` because upgrading and converging are
 * different intents: converge makes the manifest true, update moves
 * already-installed things forward.
 */
export async function systemUpdate(p: Platform): Promise<void> {
  if (p.caps.apt) {
    await aptRefreshOnce();
    log.step("apt full-upgrade");
    const env = { ...process.env, DEBIAN_FRONTEND: "noninteractive" };
    const upgrade = await spawnLogged(["sudo", "-E", "apt-get", "full-upgrade", "-y"], { env });
    if (upgrade !== 0) throw new RedError("apt full-upgrade failed");

    log.step("apt autoremove");
    await run(["sudo", "-E", "apt-get", "autoremove", "-y"], { allowFailure: true });
  }

  if (p.caps.winget) {
    log.step("winget upgrade --all");
    await run(
      wingetArgv([
        "upgrade",
        "--all",
        "--silent",
        "--accept-package-agreements",
        "--accept-source-agreements",
        "--disable-interactivity",
      ]),
      { allowFailure: true },
    );
  }
}

// -------------------------------------------------------- dispatch

export interface ApplyContext {
  // No `root`: there is nothing on disk to point at. Every config file
  // this tool writes is either a text import compiled into the binary
  // or generated from the theme, so a converge needs no checkout, no
  // clone and no download beyond the executable itself.
  platform: Platform;
  /** Theme key from src/themes.ts. */
  theme: string;
  /** Font key from src/wsl.ts NERD_FONTS. */
  font: string;
  /** Terminal font size in points. */
  fontSize?: number;
  /** Terminal background opacity, 0-100. */
  opacity: number;
}

type BuiltinName = Extract<Provider, { kind: "builtin" }>["name"];

/**
 * What each builtin is about to do, in one line.
 *
 * Written here rather than inside each module because the point is to
 * say it *before* the work starts — a module that announces itself on
 * its first line has already been imported, and the import of the agent
 * and runtime phases is itself measurable.
 */
const BUILTIN_INTENT: Partial<Record<BuiltinName, string>> = {
  "nerd-font": "installing the patched font and registering it with the host",
  "windows-terminal": "writing the Windows Terminal profile: font, opacity, colours",
  dotfiles: "writing the shell, git and editor dotfiles",
  alacritty: "writing the Alacritty config, then theming every surface that takes one",
  "wsl-interop": "checking that Windows binaries are reachable from inside the distro",
  "wsl-runtime-dir": "making sure XDG_RUNTIME_DIR exists and is owned by this user",
  blesh: "building and installing ble.sh, the bash line editor",
  runtimes: "installing language runtimes through mise",
  "shared-root": "creating the shared workspace root and its permissions",
  hotkeys: "registering the Windows hotkeys",
  "red-skills": "cloning or updating red-skills and wiring the agent plugins",
  "red-skills-vscode": "installing the red-skills VS Code extension",
  "red-skills-herdr": "installing the herdr plugin for red-skills",
  blender: "installing Blender — this one is over a gigabyte",
  "wsl-sync": "syncing the WSL distro settings with the host",
  "codex-statusline": "writing project, branch, model, effort, context and quotas into the Codex statusline",
  "claude-keybindings": "writing the Claude Code keybindings",
  "redwall-schedule": "scheduling the wallpaper rotation",
  puppeteer: "installing Puppeteer, its matching Chrome for Testing and browser dependencies",
  "ssh-server": "installing and enabling the SSH server",
};

export async function applyProvider(pr: Provider, ctx: ApplyContext): Promise<void> {
  switch (pr.kind) {
    case "apt":
      // Batched by the caller; reaching here means a one-off.
      await aptInstall([pr.pkg]);
      return;
    case "winget":
      await wingetInstall(pr.id);
      return;
    case "installer":
      await installerInstall(pr.url, pr.note, pr.args);
      return;
    case "gh":
      // Two implementations, one provider: the manifest names a release
      // asset and the platform decides how it lands. Splitting this
      // into two provider kinds would put the same repo in two places
      // and let them drift.
      if (ctx.platform.os === "windows") {
        await ghInstallWindows(pr.repo, pr.asset, pr.bin, pr.silentArgs, pr.version);
      } else {
        await ghInstall(pr.repo, pr.asset, pr.bin, pr.version);
      }
      return;
    case "ppa":
      await ppaInstall(pr.ppa, pr.pkgs);
      return;
    case "aptrepo":
      await aptRepoInstall(pr, ctx.platform.codename ?? "stable");
      return;
    case "builtin": {
      // The phases after the tools — plugins, dotfiles, themes, agents
      // — are the longest silences in a converge, because they run
      // TypeScript rather than a package manager whose own output fills
      // the screen. One line naming what is being converged is the
      // difference between a slow step and an apparently hung one.
      log.step(`builtin: ${pr.name}`);
      log.info(BUILTIN_INTENT[pr.name] ?? `converging ${pr.name} toward the desired state`);

      // Imported lazily so the Windows build does not pull WSL-only
      // code into a target that can never reach a WSL host.
      if (pr.name === "dotfiles") {
        const { installDotfiles } = await import("./dotfiles.ts");
        await installDotfiles(ctx.platform);
        return;
      }
      if (pr.name === "blesh") {
        const { installBlesh } = await import("./blesh.ts");
        await installBlesh();
        return;
      }
      if (pr.name === "runtimes") {
        const { installRuntimes } = await import("./runtimes.ts");
        await installRuntimes(ctx.platform);
        return;
      }
      if (pr.name === "alacritty") {
        const { configureAlacritty } = await import("./alacritty.ts");
        const { themeFor } = await import("./themes.ts");
        const theme = themeFor(ctx.theme);
        if (!theme) throw new RedError(`unknown theme '${ctx.theme}'`);
        const { NERD_FONTS } = await import("./wsl.ts");
        const spec = NERD_FONTS[ctx.font];
        if (!spec) throw new RedError(`unknown font '${ctx.font}'`);
        // Alacritty's config may live on the Windows host, so this can
        // fail for reasons that have nothing to do with zellij, btop or
        // neovim. Keep the surfaces independent: one unreachable
        // filesystem must not leave the machine unthemed.
        try {
          await configureAlacritty({
            platform: ctx.platform,
            fontFamily: spec.family,
            fontSize: ctx.fontSize,
            opacity: ctx.opacity,
          });
        } catch (err) {
          log.warn(`alacritty: ${(err as Error).message}`);
        }

        const { applyTerminalDefaults } = await import("./terminal-surfaces.ts");
        await applyTerminalDefaults(ctx.platform);

        // ctx.theme, not a slug derived from theme.name. Deriving it is
        // what made a converge miss every slug-indexed map while
        // `red-dev theme <name>` looked fine.
        const { applyThemeEverywhere } = await import("./theme-apply.ts");
        const { applied } = await applyThemeEverywhere(ctx.theme, ctx.platform);
        if (applied.length > 0) log.ok(`themed: ${applied.join(", ")}`);
        return;
      }
      if (pr.name === "red-skills-vscode") {
        const { installVscodeExtension } = await import("./red-skills-ext.ts");
        await installVscodeExtension();
        return;
      }
      if (pr.name === "red-skills-herdr") {
        const { installHerdrPlugin } = await import("./red-skills-ext.ts");
        await installHerdrPlugin(ctx.platform);
        return;
      }
      if (pr.name === "blender") {
        const { installBlender } = await import("./blender.ts");
        await installBlender();
        return;
      }
      if (pr.name === "red-skills") {
        const { convergeRedSkills } = await import("./agents.ts");
        await convergeRedSkills(ctx.platform);
        return;
      }
      if (pr.name === "claude-keybindings") {
        const { convergeClaudeKeybindings } = await import("./claude-keybindings.ts");
        await convergeClaudeKeybindings();
        return;
      }
      if (pr.name === "codex-statusline") {
        const { configureCodexStatusline } = await import("./codex-statusline.ts");
        await configureCodexStatusline();
        return;
      }
      if (pr.name === "redwall-schedule") {
        const { applyRedwallSchedule } = await import("./redwall-schedule.ts");
        // The outcome is dropped on purpose: every branch of it is a
        // converged machine, and the ones worth a line have already
        // printed one. Throwing is reserved for a machine that could
        // hold a schedule and refused to.
        await applyRedwallSchedule(ctx.platform);
        return;
      }
      if (pr.name === "puppeteer") {
        const { installPuppeteer } = await import("./puppeteer.ts");
        await installPuppeteer(ctx.platform);
        return;
      }
      if (pr.name === "ssh-server") {
        const { installSshServer } = await import("./ssh-server.ts");
        await installSshServer(ctx.platform);
        return;
      }
      if (pr.name === "hotkeys") {
        const { installWindowsHotkeys } = await import("./hotkeys.ts");
        await installWindowsHotkeys(ctx.platform);
        return;
      }
      if (pr.name === "wsl-sync") {
        const { syncWslDistro } = await import("./wsl-sync.ts");
        await syncWslDistro(ctx.platform);
        return;
      }
      if (pr.name === "shared-root") {
        const { ensureSharedRoot } = await import("./shared-root.ts");
        await ensureSharedRoot(ctx.platform);
        return;
      }
      const wsl = await import("./wsl.ts");
      if (pr.name === "wsl-interop") {
        await wsl.ensureWslInterop();
        return;
      }
      if (pr.name === "wsl-runtime-dir") {
        await wsl.ensureUserRuntimeDir();
        return;
      }
      if (pr.name === "nerd-font") {
        await wsl.installNerdFont(ctx.font, ctx.platform);
      } else {
        const { themeFor } = await import("./themes.ts");
        const theme = themeFor(ctx.theme);
        if (!theme) throw new RedError(`unknown theme '${ctx.theme}'`);
        const spec = wsl.NERD_FONTS[ctx.font];
        if (!spec) throw new RedError(`unknown font '${ctx.font}'`);
        await wsl.configureWindowsTerminal({
          fontFace: spec.family,
          opacity: ctx.opacity,
          distro: process.env["WSL_DISTRO_NAME"] ?? undefined,
          home: process.env["HOME"] ?? undefined,
        });
      }
      return;
    }
    case "skip":
      return;
  }
}
