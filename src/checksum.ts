/**
 * What was downloaded, and whether it is what the publisher shipped.
 *
 * Every asset this project installs arrives over the network and is then
 * executed. Until now the only thing standing between a converge and a
 * substituted binary was TLS — which answers "did this come from that
 * host", not "is this the file that host published". Several of the
 * releases involved publish a checksum beside the asset; where they do,
 * a mismatch has to stop the install rather than be interesting.
 *
 * Where they do not, the computed hash is still printed. Not security
 * theatre: it is the only record of what a machine actually installed,
 * and it is what makes two machines that behave differently comparable
 * at all.
 *
 * The parsing here is pure so the formats can be asserted without a
 * release, a network or a package manager — which is the half most
 * likely to be silently wrong, since a checksum file we fail to parse
 * looks exactly like a release that publishes none.
 */

import { createHash } from "node:crypto";
import { log, RedError } from "./log.ts";

/** Lower-case hex sha256 of the bytes as downloaded. PURE. */
export function sha256Hex(bytes: ArrayBuffer | Uint8Array | string): string {
  const view =
    typeof bytes === "string"
      ? new TextEncoder().encode(bytes)
      : bytes instanceof Uint8Array
        ? bytes
        : new Uint8Array(bytes);
  return createHash("sha256").update(view).digest("hex");
}

/** The last path segment, on either separator. PURE. */
function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Signatures are not checksums.
 *
 * A release that publishes `asset.tar.gz.sig` alongside a checksums file
 * would otherwise have the signature picked as "the file with the hash
 * in it", and every install would report a checksum it could not parse.
 */
const SIGNATURE = /\.(sig|asc|pem|minisig|gpg|sigstore|intoto\.jsonl)$/i;

/** A checksum published for one named asset: `<asset>.sha256`. */
const SIDECAR = /\.(sha256|sha256sum|sha-256)(\.txt)?$/i;

/** One file covering the whole release: SHA256SUMS, checksums.txt. */
const AGGREGATE = /(^|[._-])(checksums?|sha256sums?|sha256)(\.txt)?$/i;

/**
 * Which asset in a release carries the checksum for `file`, if any. PURE.
 *
 * The sidecar wins over the aggregate: when a release publishes both,
 * the sidecar is unambiguous and the aggregate still has to be searched
 * by name — and asset names are where the naming conventions differ
 * most between publishers.
 */
export function pickChecksumAsset(names: string[], file: string): string | null {
  const target = baseName(file).toLowerCase();
  const usable = names.filter((n) => !SIGNATURE.test(n));

  const sidecar = usable.find((n) => {
    const lower = n.toLowerCase();
    return SIDECAR.test(lower) && lower.replace(SIDECAR, "") === target;
  });
  if (sidecar) return sidecar;

  // Never the asset itself: `red-ui_0.1.0_amd64.sha256` is a sidecar for
  // a file we are not installing, and matching it would verify our
  // download against somebody else's hash.
  return usable.find((n) => AGGREGATE.test(n) && !SIDECAR.test(n)) ?? null;
}

/**
 * The hash `file` is expected to have, out of a checksum file. PURE.
 *
 * Three formats, because three are in use across the releases this
 * manifest names: GNU coreutils (`<hash>  name`, with `*name` for the
 * binary-mode variant), BSD (`SHA256 (name) = <hash>`), and a bare hash
 * with no name at all, which is what most `.sha256` sidecars contain.
 *
 * The bare hash is only used when nothing named matched. A sidecar has
 * exactly one line and no ambiguity; an aggregate that happens to carry
 * a nameless line must not have it applied to whichever asset asked.
 */
export function parseChecksums(text: string, file: string): string | null {
  const target = baseName(file).toLowerCase();
  let bare: string | null = null;

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const bsd = /^SHA-?256\s*\((.+)\)\s*=\s*([0-9a-fA-F]{64})$/.exec(line);
    if (bsd?.[1] && bsd[2]) {
      if (baseName(bsd[1].trim()).toLowerCase() === target) return bsd[2].toLowerCase();
      continue;
    }

    const gnu = /^([0-9a-fA-F]{64})(?:[ \t]+\*?(.+))?$/.exec(line);
    if (!gnu?.[1]) continue;
    const name = gnu[2]?.trim();
    if (!name) {
      bare ??= gnu[1].toLowerCase();
      continue;
    }
    if (baseName(name).toLowerCase() === target) return gnu[1].toLowerCase();
  }

  return bare;
}

/**
 * Log what the download hashed to, and refuse it if it is wrong.
 *
 * Throws on mismatch, which aborts that one item — the same failure
 * shape as a 404 or a broken archive, so converge reports it per tool
 * and carries on with the rest. An install that proceeds after a
 * mismatch would be worse than one that never checked, because the
 * check would then only exist to reassure.
 */
export function verifyChecksum(file: string, computed: string, published: string | null): void {
  if (!published) {
    log.info(`no published checksum; recording sha256 ${computed}`);
    return;
  }
  if (published.toLowerCase() !== computed.toLowerCase()) {
    throw new RedError(
      `sha256 mismatch for ${baseName(file)}: published ${published.toLowerCase()}, ` +
        `downloaded ${computed} — refusing to install`,
    );
  }
  log.ok(`sha256 matches expectation ${computed}`);
}
