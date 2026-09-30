import { expect, test } from "bun:test";
import { classifyNetworkFailure, inspectNetwork } from "./network-diagnostics.ts";

const ok = (stdout = "") => ({ stdout, stderr: "", exitCode: 0, timedOut: false, groupGone: true });

test("separates timeouts, DNS, TLS, proxy authentication and account limits", () => {
  expect(classifyNetworkFailure("curl: (28) Operation timed out")).toBe("timeout");
  expect(classifyNetworkFailure("Could not resolve host: github.com")).toBe("dns");
  expect(classifyNetworkFailure("certificate signed by unknown authority")).toBe("tls");
  expect(classifyNetworkFailure("", 407)).toBe("proxy");
  expect(classifyNetworkFailure("", 429)).toBe("rate-limit");
  expect(classifyNetworkFailure("", 401)).toBe("authentication");
  expect(classifyNetworkFailure("", 403)).toBe("unavailable");
});

test("shows a local credential stall independently of successful OS HTTP requests", async () => {
  const calls: string[][] = [];
  const report = await inspectNetwork({
    locate: name => `/bin/${name}`, gh: () => "/real/gh", env: {},
    run: async (argv, options) => {
      calls.push(argv);
      expect(options!.timeoutMs).toBeLessThanOrEqual(12_000);
      if (argv[1] === "token") return { ...ok("gho_SECRET_TOKEN_DO_NOT_EXPORT"), timedOut: true, exitCode: null };
      if (argv[0]!.endsWith("curl")) return ok("200");
      return ok("gho_SECRET_TOKEN_DO_NOT_EXPORT");
    },
  });
  expect(report.checks.find(check => check.name === "mise credential (local)")?.failure).toBe("timeout");
  expect(report.checks.find(check => check.name === "GitHub API")?.status).toBe("ok");
  expect(JSON.stringify(report)).not.toContain("SECRET_TOKEN");
  expect(calls.every(argv => !argv.some(arg => arg.includes("SECRET_TOKEN")))).toBe(true);
});

test("never exports proxy addresses, credentials, URLs with passwords or environment dumps", async () => {
  const report = await inspectNetwork({
    locate: name => `/bin/${name}`, gh: () => "/real/gh", env: { HTTPS_PROXY: "https://alice:private-password@proxy.example" },
    run: async () => ({ ...ok("gho_neverRetainThisCredential"), exitCode: 1,
      stderr: "TLS certificate error https://alice:private-password@proxy.example Authorization: Bearer private-token" }),
  });
  const encoded = JSON.stringify(report);
  expect(report.proxyConfigured).toBe(true);
  expect(encoded).not.toContain("private-password");
  expect(encoded).not.toContain("private-token");
  expect(encoded).not.toContain("neverRetain");
});

test("an empty credential or mise source none is an authentication failure even with exit zero", async () => {
  const report = await inspectNetwork({
    locate: name => `/bin/${name}`, gh: () => "/real/gh", env: {},
    run: async (argv) => {
      if (argv[0] === "/real/gh") return ok("");
      if (argv[1] === "token") return ok("Source: none\n");
      return ok("200");
    },
  });
  for (const check of report.checks.filter(check => check.name.includes("credential"))) {
    expect(check.status).toBe("failed");
    expect(check.failure).toBe("authentication");
  }
});
