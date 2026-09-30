/** Retry only transient/rate-limited responses, within one total deadline. */
export function retryDelay(response: Response, attempt: number, now = Date.now(), random = Math.random): number | null {
  const limited = response.status === 429 || (response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")));
  if (!limited && ![502, 503, 504].includes(response.status)) return null;
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
    if (Number.isFinite(date)) return Math.max(0, date - now);
  }
  if (limited) {
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
    // Secondary limits explicitly recommend waiting at least a minute.
    return 60_000;
  }
  return Math.round(500 * 2 ** attempt + random() * 500);
}

export async function fetchWithRetry(url: string, options: {
  fetcher?: typeof fetch;
  init?: RequestInit;
  timeoutMs: number;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  onRetry?: (delayMs: number, status: number) => void;
}): Promise<Response> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) throw new DOMException("HTTP request deadline reached", "TimeoutError");
    const signal = options.init?.signal
      ? AbortSignal.any([options.init.signal, AbortSignal.timeout(remaining)])
      : AbortSignal.timeout(remaining);
    const response = await (options.fetcher ?? fetch)(url, { ...options.init, signal });
    const delay = retryDelay(response, attempt, now());
    // Leave time for another request. Never retry before the server permits it.
    if (attempt >= 2 || delay === null || delay + 1000 >= deadline - now()) return response;
    await response.body?.cancel();
    options.onRetry?.(delay, response.status);
    await wait(delay);
  }
}

export function httpFailureAdvice(response: Response): string {
  const retry = response.headers.get("retry-after");
  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (retry) return ` — retry after ${retry}; do not repeatedly retry before then`;
  if (response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0 && reset * 1000 <= 8.64e15) return ` — quota resets at ${new Date(reset * 1000).toISOString()}`;
  if (response.status === 407) return " — corporate proxy authentication refused";
  if (response.status === 403) return " — access refused; a 403 without quota headers does not prove a rate limit";
  return "";
}
