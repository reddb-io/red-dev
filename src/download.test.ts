/**
 * The download, with the network and the disk injected.
 *
 * The pure half of the checksum work is asserted in checksum.test.ts.
 * What this asks is the part that only exists once they are wired
 * together: that a published checksum is actually fetched and compared,
 * that a mismatch stops before anything reaches the disk, and that a
 * release publishing no checksum still installs.
 */

import { describe, expect, test } from "bun:test";
import { downloadVerified } from "./providers.ts";
import { sha256Hex } from "./checksum.ts";

const ASSET = "red-1.0-linux.tar.gz";
const URL = `https://example.invalid/${ASSET}`;
const BODY = new TextEncoder().encode("the asset bytes");
const HASH = sha256Hex(BODY);

/** A network that answers from a map, and records what was asked for. */
function net(routes: Record<string, { status?: number; body?: string | Uint8Array }>) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const hit = routes[url];
    if (!hit) return new Response("", { status: 404 });
    return new Response(hit.body ?? "", { status: hit.status ?? 200 });
  }) as unknown as typeof fetch;
  return { fetcher, asked };
}

function sink() {
  const written: { path: string; bytes: number }[] = [];
  return {
    written,
    write: async (path: string, bytes: Uint8Array) => {
      written.push({ path, bytes: bytes.byteLength });
    },
  };
}

describe("downloadVerified", () => {
  test("writes the file and reports its sha256", async () => {
    const { fetcher } = net({ [URL]: { body: BODY } });
    const disk = sink();

    const result = await downloadVerified(URL, `/tmp/${ASSET}`, { fetcher, write: disk.write });

    expect(result.sha256).toBe(HASH);
    expect(result.bytes).toBe(BODY.byteLength);
    expect(disk.written).toEqual([{ path: `/tmp/${ASSET}`, bytes: BODY.byteLength }]);
  });

  test("compares against the checksum the release publishes", async () => {
    const sums = `${HASH}  ${ASSET}\n`;
    const { fetcher, asked } = net({
      [URL]: { body: BODY },
      "https://example.invalid/SHA256SUMS": { body: sums },
    });
    const disk = sink();

    await downloadVerified(URL, `/tmp/${ASSET}`, {
      fetcher,
      write: disk.write,
      checksumUrl: "https://example.invalid/SHA256SUMS",
    });

    expect(asked).toContain("https://example.invalid/SHA256SUMS");
    expect(disk.written).toHaveLength(1);
  });

  test("a mismatch aborts before anything is written", async () => {
    // The whole reason to verify before writing: a rejected asset must
    // not be sitting in the temp directory the next branch unpacks.
    const sums = `${"f".repeat(64)}  ${ASSET}\n`;
    const { fetcher } = net({
      [URL]: { body: BODY },
      "https://example.invalid/SHA256SUMS": { body: sums },
    });
    const disk = sink();

    await expect(
      downloadVerified(URL, `/tmp/${ASSET}`, {
        fetcher,
        write: disk.write,
        checksumUrl: "https://example.invalid/SHA256SUMS",
      }),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(disk.written).toEqual([]);
  });

  test("a checksum file that cannot be read is not a failure", async () => {
    // A rate-limited or withdrawn checksums file is not evidence that
    // the download is wrong, and refusing to install over one would make
    // this project's reliability depend on GitHub's mood.
    const { fetcher } = net({ [URL]: { body: BODY } });
    const disk = sink();

    const result = await downloadVerified(URL, `/tmp/${ASSET}`, {
      fetcher,
      write: disk.write,
      checksumUrl: "https://example.invalid/missing-sums",
    });

    expect(result.sha256).toBe(HASH);
    expect(disk.written).toHaveLength(1);
  });

  test("a checksums file with no line for this asset installs anyway", async () => {
    const { fetcher } = net({
      [URL]: { body: BODY },
      "https://example.invalid/SHA256SUMS": { body: `${"e".repeat(64)}  someone-else.zip\n` },
    });
    const disk = sink();

    await downloadVerified(URL, `/tmp/${ASSET}`, {
      fetcher,
      write: disk.write,
      checksumUrl: "https://example.invalid/SHA256SUMS",
    });

    expect(disk.written).toHaveLength(1);
  });

  test("a failed download never writes and says which status it got", async () => {
    const { fetcher } = net({ [URL]: { status: 503 } });
    const disk = sink();

    await expect(
      downloadVerified(URL, `/tmp/${ASSET}`, { fetcher, write: disk.write }),
    ).rejects.toThrow(/download failed 503/);
    expect(disk.written).toEqual([]);
  });
});
