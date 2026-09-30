import { runBounded, type BoundedCommandOptions, type BoundedCommandResult } from "./bounded-command.ts";
import { resolveGithubCli } from "./github-cli-bin.ts";
import { log } from "./log.ts";
import { redactDiagnostic } from "./rotating-log.ts";

type Command = (argv: string[], options?: BoundedCommandOptions) => Promise<BoundedCommandResult>;
export type NetworkFailure = "timeout" | "dns" | "tls" | "proxy" | "rate-limit" | "authentication" | "unavailable";
export interface NetworkCheck {
  name: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
  elapsedMs: number;
  failure?: NetworkFailure;
  fix?: string;
}
export interface NetworkReport {
  schema: "red.network-diagnostics.v1";
  proxyConfigured: boolean;
  checks: NetworkCheck[];
}

export function classifyNetworkFailure(output: string, status?: number): NetworkFailure {
  if (status === 407 || /proxy authentication|CONNECT tunnel failed|could not resolve proxy/i.test(output)) return "proxy";
  if (status === 429 || /rate.?limit|too many requests/i.test(output)) return "rate-limit";
  if (status === 401 || /bad credentials|not logged|not authenticated/i.test(output)) return "authentication";
  if (/could not resolve host|ENOTFOUND|EAI_AGAIN|dns error/i.test(output)) return "dns";
  if (/certificate|UnknownIssuer|SSL peer|TLS handshake/i.test(output)) return "tls";
  if (/timed? ?out|TimeoutError|deadline|curl: \(28\)/i.test(output)) return "timeout";
  return "unavailable";
}

const advice: Record<NetworkFailure, string> = {
  timeout: "Check VPN/proxy reachability to this host; a gh login does not fix a network timeout.",
  dns: "Check DNS resolution while connected to the VPN.",
  tls: "Install the corporate CA in the OS trust store; keep certificate verification enabled.",
  proxy: "Check the corporate proxy address and authentication.",
  "rate-limit": "Use the active gh login and wait until Retry-After or the rate-limit reset.",
  authentication: "Run gh auth status --hostname github.com; inspect token override names without printing their values.",
  unavailable: "Check the reported host and HTTP status with the network administrator.",
};

/** Separate local credentials, OS network access and mise's own HTTP client. */
export async function inspectNetwork(options: {
  run?: Command;
  locate?: (name: string) => string | null;
  gh?: () => string | null;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  onCheck?: (check: NetworkCheck) => void;
} = {}): Promise<NetworkReport> {
  const run = options.run ?? runBounded;
  const locate = options.locate ?? Bun.which;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const checks: NetworkCheck[] = [];
  const record = (check: NetworkCheck): void => { checks.push(check); options.onCheck?.(check); };
  const check = async (name: string, argv: string[] | null, kind: "credential" | "curl" | "mise"): Promise<void> => {
    if (!argv) { record({ name, status: "skipped", detail: "executable unavailable", elapsedMs: 0 }); return; }
    const started = now();
    try {
      const result = await run(argv, { timeoutMs: kind === "credential" ? 3_000 : 12_000,
        env: { ...env, GH_NO_UPDATE_NOTIFIER: "1", GH_PROMPT_DISABLED: "1", MISE_AUTO_INSTALL: "0", MISE_YES: "1",
          ...(kind === "mise" ? { MISE_FETCH_REMOTE_VERSIONS_CACHE: "0s", MISE_HTTP_TIMEOUT: "10s" } : {}) } });
      const elapsedMs = now() - started;
      // Credential output is never retained, even in an exported report.
      if (kind === "credential" && result.exitCode === 0 && !result.timedOut && result.stdout.trim() && !/source:\s*(?:none|unset)|no token/i.test(result.stdout)) {
        const source = /source:\s*([a-z_]+)/i.exec(result.stdout)?.[1];
        record({ name, status: "ok", detail: source ? `credential source: ${source}` : "active gh credential available", elapsedMs });
        return;
      }
      const status = kind === "curl" ? Number(result.stdout.trim()) : undefined;
      if (kind !== "credential" && !result.timedOut && result.exitCode === 0 && (kind !== "curl" || (status! >= 200 && status! < 400))) {
        record({ name, status: "ok", detail: kind === "curl" ? `HTTP ${status}` : "mise remote-version request succeeded", elapsedMs });
        return;
      }
      const output = kind === "credential" ? "credential lookup failed" : redactDiagnostic(result.stderr).slice(0, 600);
      const failure = result.timedOut ? "timeout" : kind === "credential" ? "authentication" : classifyNetworkFailure(output, status);
      record({ name, status: "failed", failure, elapsedMs,
        detail: result.timedOut ? "absolute probe deadline reached" : `exit ${result.exitCode}${status ? `; HTTP ${status}` : ""}${output ? `; ${output}` : ""}`,
        fix: advice[failure] });
    } catch (error) {
      const detail = redactDiagnostic(error instanceof Error ? error.message : String(error)).slice(0, 600);
      const failure = classifyNetworkFailure(detail);
      record({ name, status: "failed", detail, elapsedMs: now() - started, failure, fix: advice[failure] });
    }
  };
  const gh = options.gh ? options.gh() : resolveGithubCli();
  const mise = locate("mise");
  await check("gh credential (local)", gh ? [gh, "auth", "token", "--hostname", "github.com"] : null, "credential");
  await check("mise credential (local)", mise ? [mise, "token", "github"] : null, "credential");
  const curl = locate(process.platform === "win32" ? "curl.exe" : "curl");
  for (const [name, url] of [
    ["GitHub API", "https://api.github.com/rate_limit"],
    ["GitHub release", "https://github.com/reddb-io/red-dev/releases/latest/download/SHA256SUMS"],
    ["npm registry", "https://registry.npmjs.org/"],
  ]) {
    await check(name!, curl ? [curl, "--silent", "--show-error", "--location", "--max-redirs", "5",
      "--connect-timeout", "5", "--max-time", "10", "--output", process.platform === "win32" ? "NUL" : "/dev/null",
      "--write-out", "%{http_code}", url!] : null, "curl");
  }
  await check("mise GitHub request", mise ? [mise, "ls-remote", "github:reddb-io/red-dev"] : null, "mise");
  return { schema: "red.network-diagnostics.v1", proxyConfigured: ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY", "ALL_PROXY", "all_proxy"].some(name => Boolean(env[name])), checks };
}

export async function networkCommand(json = false): Promise<number> {
  const show = (check: NetworkCheck): void => {
    const detail = `${check.name}: ${check.detail} (${check.elapsedMs}ms)`;
    if (check.status === "ok") log.ok(detail);
    else if (check.status === "skipped") log.skip(detail);
    else log.err(detail);
    if (check.fix) log.plain(`       fix: ${check.fix}`);
  };
  if (!json) log.step("network: checking local credentials, OS reachability and mise (bounded probes)");
  const report = await inspectNetwork({ onCheck: json ? undefined : show });
  if (json) log.plain(JSON.stringify(report, null, 2));
  else log.info(`proxy environment: ${report.proxyConfigured ? "configured (address omitted)" : "not configured"}`);
  return report.checks.some(check => check.status === "failed") ? 1 : 0;
}
