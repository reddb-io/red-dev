/**
 * Decode output crossing from a native Windows process into Bun.
 *
 * Most commands emit UTF-8, while WSL's own CLI emits UTF-16LE when
 * stdout is redirected. Treating those bytes as UTF-8 leaves a NUL
 * after every ASCII character and corrupts every non-ASCII character.
 */
export function decodeWindowsOutput(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  const hasUtf16LeBom = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe;
  let oddNuls = 0;
  let evenNuls = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 0) continue;
    if (i % 2 === 0) evenNuls++;
    else oddNuls++;
  }

  // ASCII-heavy UTF-16LE has NUL in most odd byte positions. Requiring
  // both a useful ratio and a strong odd/even bias avoids guessing from
  // an incidental NUL in otherwise normal UTF-8 output.
  const pairs = Math.floor(bytes.length / 2);
  const looksUtf16Le = pairs > 0 && oddNuls / pairs >= 0.25 && oddNuls > evenNuls * 2;
  const decoder = hasUtf16LeBom || looksUtf16Le ? new TextDecoder("utf-16") : new TextDecoder();
  return decoder.decode(bytes);
}

export async function readWindowsOutput(stream: ReadableStream<Uint8Array>): Promise<string> {
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return decodeWindowsOutput(bytes);
}
