import { expect, test } from "bun:test";
import { fetchWithRetry, retryDelay } from "./http-policy.ts";

test("respects quota reset, Retry-After seconds and dates; does not retry invalid credentials", () => {
  expect(retryDelay(new Response("", { status: 401 }), 0)).toBeNull();
  expect(retryDelay(new Response("", { status: 403 }), 0)).toBeNull();
  expect(retryDelay(new Response("", { status: 429, headers: { "retry-after": "5" } }), 0)).toBe(5000);
  expect(retryDelay(new Response("", { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "120" } }), 0, 100_000)).toBe(20_000);
  expect(retryDelay(new Response("", { status: 429, headers: { "retry-after": new Date(120_000).toUTCString() } }), 0, 100_000)).toBe(20_000);
});

test("recovers from a temporary 503 without an unbounded request loop", async () => {
  let attempts = 0; let clock = 0; const waits: number[] = [];
  const response = await fetchWithRetry("https://fixture", {
    timeoutMs: 10_000, now: () => clock,
    fetcher: (async () => new Response("", { status: ++attempts < 3 ? 503 : 200, headers: { "retry-after": "1" } })) as unknown as typeof fetch,
    wait: async ms => { waits.push(ms); clock += ms; },
  });
  expect(response.status).toBe(200);
  expect(attempts).toBe(3); expect(waits).toEqual([1000, 1000]);
});

test("does not sleep until next hour or shorten a Retry-After to force another attempt", async () => {
  let attempts = 0;
  const response = await fetchWithRetry("https://fixture", {
    timeoutMs: 10_000,
    fetcher: (async () => { attempts++; return new Response("", { status: 429, headers: { "retry-after": "3600" } }); }) as unknown as typeof fetch,
    wait: async () => { throw new Error("must not wait"); },
  });
  expect(response.status).toBe(429); expect(attempts).toBe(1);
});
