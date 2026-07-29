/**
 * Which Docker daemon this machine should use.
 *
 * The failure this prevents: two daemons on one machine. Docker Desktop
 * runs its own inside a hidden `docker-desktop` distro and shares it
 * with Windows and every distro that has WSL integration enabled.
 * Installing docker-ce inside Ubuntu adds a *second*, independent
 * daemon — and containers under one are invisible to the other, on
 * separate networks, with separate volumes.
 *
 * Nothing errors. `docker ps` works on both sides and shows different
 * things, which is a genuinely confusing way to lose an afternoon: you
 * start a database from Windows, your app in WSL cannot reach it, and
 * every individual command looks correct.
 *
 * So on WSL the rule is: if the host already serves a daemon here, use
 * it. Only install a local one when nothing else provides it.
 */

import { existsSync } from "node:fs";
import type { Platform } from "./platform.ts";

export type DockerSource =
  /** Docker Desktop on the Windows host, shared into this distro. */
  | { kind: "desktop-integration"; detail: string }
  /** A dockerd installed inside this distro. */
  | { kind: "native"; detail: string }
  /** Nothing provides a daemon here yet. */
  | { kind: "none"; detail: string };

/**
 * Docker Desktop shares its daemon by bind-mounting its CLI tools and
 * socket into the distro under /mnt/wsl. That directory existing is the
 * signal, and it is present whether or not the daemon happens to be
 * running right now — which is what we want, because "Docker Desktop
 * owns Docker here" is a configuration fact, not a runtime one.
 */
export function detectDockerSource(p: Platform): DockerSource {
  if (p.env !== "wsl") {
    return { kind: "none", detail: "not WSL" };
  }

  if (existsSync("/mnt/wsl/docker-desktop")) {
    return {
      kind: "desktop-integration",
      detail: "Docker Desktop shares its daemon with this distro",
    };
  }

  // A docker binary that resolves into /mnt/wsl is Docker Desktop's CLI
  // rather than a locally installed one, even if the mount above moved.
  const bin = Bun.which("docker");
  if (bin?.startsWith("/mnt/wsl")) {
    return {
      kind: "desktop-integration",
      detail: `docker CLI comes from the host (${bin})`,
    };
  }

  if (existsSync("/var/run/docker.sock") && bin) {
    return { kind: "native", detail: "a dockerd runs inside this distro" };
  }

  return { kind: "none", detail: "no daemon reachable here" };
}

/**
 * Whether red-dev should install docker-ce into this distro.
 *
 * Returning a reason rather than a bare boolean so the plan can say why
 * it is skipping — a silent skip on something as load-bearing as Docker
 * reads like the manifest forgot.
 */
export function shouldInstallDockerHere(p: Platform): { install: boolean; reason: string } {
  const source = detectDockerSource(p);

  if (source.kind === "desktop-integration") {
    return {
      install: false,
      reason:
        "Docker Desktop already serves this distro; a second daemon would not share its containers",
    };
  }

  return { install: true, reason: "" };
}

/** For `doctor`: is Docker set up in a way that will confuse someone? */
export async function dockerHealth(
  p: Platform,
): Promise<{ ok: boolean; detail: string; fix?: string }> {
  if (!Bun.which("docker")) {
    return { ok: true, detail: "docker not installed" };
  }

  const source = detectDockerSource(p);

  // The real question is which daemon answers, not which files exist.
  const proc = Bun.spawn(
    ["docker", "info", "--format", "{{.OperatingSystem}}|{{.ServerVersion}}"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  const code = await proc.exited;

  if (code !== 0) {
    return {
      ok: false,
      detail: "docker is installed but no daemon answers",
      fix: p.env === "wsl" ? "start Docker Desktop, or: sudo service docker start" : undefined,
    };
  }

  const [os = "?", version = "?"] = out.split("|");

  // Both present is the case worth flagging: a local daemon while the
  // host also offers one means two isolated worlds on one machine.
  if (source.kind === "native" && existsSync("/mnt/wsl/docker-desktop")) {
    return {
      ok: false,
      detail: `two daemons: a local dockerd and Docker Desktop. Containers started in one are invisible to the other`,
      fix: "pick one — disable WSL integration for this distro, or `sudo apt remove docker-ce`",
    };
  }

  return {
    ok: true,
    detail:
      source.kind === "desktop-integration"
        ? `Docker Desktop (${version}) — shared with Windows`
        : `local daemon ${version} on ${os}`,
  };
}
