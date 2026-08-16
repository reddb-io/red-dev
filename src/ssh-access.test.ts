/**
 * Authorizing a GitHub account, and the four things that must stay true
 * about it.
 *
 * This is the one feature in red-dev where a bug is somebody else on the
 * machine, so the order of operations is pinned rather than assumed:
 * fetched, shown, and only then written. Every test below can run on a
 * laptop with no network and no sshd, because the two things that reach
 * outside — github.com and the service manager — arrive as arguments.
 *
 * The keys are real ones, generated with ssh-keygen, and their SHA256
 * fingerprints are what `ssh-keygen -lf` prints for them. That is the
 * cross-check worth having: a fingerprint this file computed from the
 * same code it is testing would agree with itself and with nothing else,
 * and the fingerprint is the whole basis on which a person says yes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildCli, parseArgs } from "./cli.ts";
import type { Capabilities, Platform } from "./platform.ts";
import {
  BLOCK_BEGIN,
  BLOCK_END,
  authorizeGithubKeys,
  authorizedKeysPath,
  fetchGithubKeys,
  fingerprint,
  githubKeysUrl,
  offerGithubKeys,
  parsePublicKeys,
  revertSshAccess,
  sshAccessRemoval,
  withAuthorizedKeys,
  withoutAuthorizedKeys,
  type Fetcher,
  type PublicKey,
} from "./ssh-access.ts";
import { removableTools } from "./uninstall.ts";

const ED25519 =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEOV6pcgvZNZeqx7DivmPlLqwtwdNc/maLQRKQ3Bhy2L";
const ED25519_FINGERPRINT = "SHA256:WBFrhh+pJRrUxReQ25i44O0A+dynVQwxm2uOOeNmGUc";
const RSA =
  "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC0ctOcesgVAd6vbp8VwiBvaFaWTx6c1k+ztiKy7E/i" +
  "Cj2xZGHWLd+Km19LwFDUu7BWrpXwAyA3jAF9cjvNIPloh0h3iqo53dzc8zDQOrw+fKBsr9TNx3CM157T" +
  "zuqm/JKeRc/ubv22+Po4DoXUtQZnma8Pdt/vJnmXI0J5SJkj62NBUAKU0VNmExVFeSdIM5EkRBjW+/IM" +
  "qmK/ZFnReCNQABgvm5JHbWo8N5odCuNSZ4JVp8IFZR3cDPi6i9PU692CsyP/JVajcTA4l7bMDCE8e1sR" +
  "/K77//zJoqnv0/D+vbRL0gVhB97wUrFGmcnTGF3FeW6X0PINmC4oy3d0lpX/";
const RSA_FINGERPRINT = "SHA256:dcVXR5GgUzzJow1erUeK1JNEiDoEZDhov78xMlG5C00";

/** What github.com/<user>.keys answers: bare keys, no comments. */
const PUBLISHED = `${ED25519}\n${RSA}\n`;

const homes: string[] = [];

function freshHome(): string {
  const home = mkdtempSync(`${tmpdir()}/red-dev-ssh-`);
  homes.push(home);
  return home;
}

afterEach(() => {
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true });
});

/** github.com, without github.com. */
function published(body = PUBLISHED, status = 200): { fetch: Fetcher; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetch: async (url) => {
      urls.push(url);
      return { ok: status < 400, status, text: async () => body };
    },
  };
}

function platform(over: Partial<Platform> = {}): Platform {
  return {
    os: "linux",
    env: "wsl",
    arch: "x64",
    version: "24.04",
    caps: {
      apt: true,
      gui: false,
      systemd: true,
      winget: false,
      flatpak: false,
    } satisfies Capabilities,
    ...over,
  } as Platform;
}

describe("the keys are fetched for a username and shown", () => {
  test("from the address GitHub publishes them at, and nowhere else", () => {
    expect(githubKeysUrl("octocat")).toBe("https://github.com/octocat.keys");
    // The username lands in a URL, so it is checked against GitHub's own
    // rule before it is interpolated into one. Without this, a slash or
    // a query string in that slot fetches something that is not a key
    // list and this file reports whatever came back as keys.
    for (const bad of ["../settings", "oct/cat", "-octocat", "octocat-", "", "a".repeat(40)]) {
      expect(() => githubKeysUrl(bad)).toThrow();
    }
  });

  test("shown by the fingerprint a person can check them against", async () => {
    const keys = await fetchGithubKeys("octocat", published().fetch);
    expect(keys.map((k) => k.type)).toEqual(["ssh-ed25519", "ssh-rsa"]);
    // The strings `ssh-keygen -lf` prints for these two keys, typed in
    // rather than computed here.
    expect(keys.map(fingerprint)).toEqual([ED25519_FINGERPRINT, RSA_FINGERPRINT]);
    // Ours, not GitHub's: the endpoint returns bare keys, and this is
    // the only place the account name survives into the file.
    expect(keys.every((k) => k.comment === "octocat@github")).toBe(true);
  });

  test("and shown before anything is written", async () => {
    const home = freshHome();
    const path = authorizedKeysPath(home);
    const shown: string[] = [];
    const seenAtConfirm: { existed: boolean; shown: number } = { existed: true, shown: -1 };

    const result = await authorizeGithubKeys("octocat", {
      home,
      fetch: published().fetch,
      show: (line) => shown.push(line),
      confirm: async () => {
        // The whole ordering claim, asserted from inside the question:
        // both keys are on screen and the file does not exist yet.
        seenAtConfirm.existed = existsSync(path);
        seenAtConfirm.shown = shown.length;
        return true;
      },
    });

    expect(seenAtConfirm.existed).toBe(false);
    expect(shown.join("\n")).toContain(ED25519_FINGERPRINT);
    expect(shown.join("\n")).toContain(RSA_FINGERPRINT);
    expect(seenAtConfirm.shown).toBe(shown.length);
    expect(result.status).toBe("written");
  });

  test("an account that does not exist and one with no keys are different answers", async () => {
    // Two different next steps — check the spelling, or publish a key —
    // and one "could not fetch keys" sends a person to neither.
    await expect(fetchGithubKeys("octocat", published("Not Found", 404).fetch)).rejects.toThrow(
      /no account named 'octocat'/,
    );
    await expect(fetchGithubKeys("octocat", published("", 200).fetch)).rejects.toThrow(
      /published no public keys/,
    );
  });
});

describe("the keys land in the authorized keys file only after confirmation", () => {
  test("a no writes nothing at all", async () => {
    const home = freshHome();
    const result = await authorizeGithubKeys("octocat", {
      home,
      fetch: published().fetch,
      show: () => {},
      confirm: async () => false,
    });

    expect(result.status).toBe("declined");
    expect(result.added).toEqual([]);
    // Not an empty file, not an empty ~/.ssh: a declined authorization
    // leaves the machine as it was, which is why the directory is
    // created after the answer rather than before the fetch.
    expect(existsSync(authorizedKeysPath(home))).toBe(false);
    expect(existsSync(`${home}/.ssh`)).toBe(false);
  });

  test("a yes writes both keys, between markers, readable only by their owner", async () => {
    const home = freshHome();
    const result = await authorizeGithubKeys("octocat", {
      home,
      fetch: published().fetch,
      show: () => {},
      confirm: async () => true,
    });

    expect(result.status).toBe("written");
    expect(result.added).toHaveLength(2);

    const body = readFileSync(authorizedKeysPath(home), "utf8");
    expect(body).toContain(`${ED25519} octocat@github`);
    expect(body).toContain(`${RSA} octocat@github`);
    expect(body).toContain(BLOCK_BEGIN);
    expect(body).toContain(BLOCK_END);

    if (process.platform !== "win32") {
      // sshd refuses a group-readable authorized_keys and says so only
      // in its own log — the machine has the right key in the right file
      // and still refuses every connection.
      expect(statSync(authorizedKeysPath(home)).mode & 0o777).toBe(0o600);
      expect(statSync(`${home}/.ssh`).mode & 0o777).toBe(0o700);
    }
  });

  test("what somebody else put in the file survives both directions", async () => {
    const home = freshHome();
    mkdirSync(`${home}/.ssh`, { recursive: true });
    const mine = `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHandWrittenKeyOfMyOwn me@laptop`;
    writeFileSync(authorizedKeysPath(home), `${mine}\n`);

    await authorizeGithubKeys("octocat", {
      home,
      fetch: published().fetch,
      show: () => {},
      confirm: async () => true,
    });
    const after = readFileSync(authorizedKeysPath(home), "utf8");
    expect(after).toContain(mine);

    const stripped = withoutAuthorizedKeys(after);
    expect(stripped.removed).toHaveLength(2);
    expect(stripped.body.trim()).toBe(mine);
  });

  test("a second run adds nothing and says so", async () => {
    const home = freshHome();
    const twice = () =>
      authorizeGithubKeys("octocat", {
        home,
        fetch: published().fetch,
        show: () => {},
        confirm: async () => true,
      });
    await twice();
    const again = await twice();
    expect(again.status).toBe("unchanged");
    expect(again.added).toEqual([]);
    expect(readFileSync(authorizedKeysPath(home), "utf8").match(/ssh-ed25519/g)).toHaveLength(1);
  });

  test("a key already restricted by hand is not re-added unrestricted", () => {
    // `command="…" ssh-rsa AAAA…` is somebody's deliberate limit. Adding
    // a plain second copy of the same key would quietly widen what that
    // key may do, which is the one merge mistake with a security cost.
    const restricted = `command="/usr/bin/backup",no-pty ${RSA}\n`;
    const key = parsePublicKeys(`${RSA}\n`)[0] as PublicKey;
    expect(withAuthorizedKeys(restricted, [key]).added).toEqual([]);
  });
});

describe("the question never appears in the non-interactive install path", () => {
  /** Both halves of `interactive()`, put where a test can move them. */
  function withTty<T>(isTTY: boolean, body: () => Promise<T>): Promise<T> {
    const before = { stdin: process.stdin.isTTY, stdout: process.stdout.isTTY };
    Object.assign(process.stdin, { isTTY });
    Object.assign(process.stdout, { isTTY });
    return body().finally(() => {
      Object.assign(process.stdin, { isTTY: before.stdin });
      Object.assign(process.stdout, { isTTY: before.stdout });
    });
  }

  test("nothing is asked, and nothing is written, without a terminal", async () => {
    const home = freshHome();
    let asked = 0;
    const result = await withTty(false, () =>
      offerGithubKeys(platform(), {
        home,
        ask: async () => {
          asked++;
          return "octocat";
        },
        fetch: published().fetch,
        show: () => {},
        confirm: async () => true,
      }),
    );

    // Not "asked and defaulted to no": never asked. A prompt with nobody
    // to answer it is a hang, and this runs in CI, in a pipe and over a
    // non-interactive SSH.
    expect(asked).toBe(0);
    expect(result).toBeNull();
    expect(existsSync(authorizedKeysPath(home))).toBe(false);
  });

  test("and is asked when there is somebody to answer", async () => {
    const home = freshHome();
    const result = await withTty(true, () =>
      offerGithubKeys(platform(), {
        home,
        ask: async () => "octocat",
        fetch: published().fetch,
        show: () => {},
        confirm: async () => true,
      }),
    );
    expect(result?.status).toBe("written");
  });

  test("the converge cannot reach the question even by accident", () => {
    // The structural half. `interactive()` is what makes the ask safe,
    // but the guarantee worth pinning is that no part of a converge
    // imports the module that asks: the loop, the providers, and the
    // item that opens the port.
    for (const file of ["converge.ts", "providers.ts", "ssh-server.ts"]) {
      const source = readFileSync(`src/${file}`, "utf8");
      expect([file, source.includes("./ssh-access.ts")]).toEqual([file, false]);
      expect([file, source.includes('from "./ui.ts"')]).toEqual([file, false]);
    }
  });

  test("and install asks only inside its first-run branch", () => {
    const main = readFileSync("src/main.ts", "utf8");
    const guard = main.indexOf("if (!inv.dryRun && !inv.yes && !inv.scope) {");
    const ask = main.indexOf("offerGithubKeys(p)");
    const converging = main.indexOf("// Repairs before converging");
    expect(guard).toBeGreaterThan(-1);
    // Between the gate and the converge: `--yes`, `--dry-run`, a scope
    // argument and a machine already set up all skip it, and the
    // converge below it never sees a prompt.
    expect(ask).toBeGreaterThan(guard);
    expect(ask).toBeLessThan(converging);
  });

  test("the explicit command is the other way in", () => {
    const inv = parseArgs(buildCli(), ["ssh", "octocat"]);
    expect(inv.errors).toEqual([]);
    expect(inv.command).toBe("ssh");
    expect(inv.sshUser).toBe("octocat");
    // Unattended, and only when asked for in as many words.
    expect(parseArgs(buildCli(), ["ssh", "octocat", "--yes"]).yes).toBe(true);
    expect(inv.yes).toBe(false);

    // Parsed and reachable. A command the CLI accepts and the switch
    // does not handle is "unhandled command: ssh" at exit 1, which is a
    // sentence only this test would ever read.
    const main = readFileSync("src/main.ts", "utf8");
    expect(main).toContain('case "ssh":');
    // Without a terminal it refuses rather than defaulting to no:
    // `confirm` answers false with nobody there, so the command would
    // print two fingerprints and exit 0 having authorized nothing.
    expect(main).toContain("if (!inv.yes && !interactive()) {");
  });
});

describe("removal reverts authorized keys, firewall rule and service together", () => {
  /** A home that has been through an authorization. */
  async function authorized(): Promise<string> {
    const home = freshHome();
    await authorizeGithubKeys("octocat", {
      home,
      fetch: published().fetch,
      show: () => {},
      confirm: async () => true,
    });
    return home;
  }

  test("Ubuntu: the unit is disabled and stopped, and the keys come out", async () => {
    const home = await authorized();
    const ran: string[][] = [];
    const reverted = await revertSshAccess(platform(), {
      home,
      run: async (cmd) => {
        ran.push(cmd);
        // `list-unit-files ssh.service` answering first is this distro
        // calling it ssh rather than sshd.
        return { ok: true, out: "" };
      },
    });

    expect(ran[0]).toEqual(["systemctl", "list-unit-files", "ssh.service"]);
    expect(ran[1]).toEqual(["sudo", "-n", "systemctl", "disable", "--now", "ssh"]);
    // --now as well as disable: disabling alone leaves the running
    // server listening until the next reboot, which is a machine that
    // reports itself reverted and still answers on 22.
    expect(reverted.removedKeys).toHaveLength(2);
    expect(readFileSync(authorizedKeysPath(home), "utf8")).not.toContain("ssh-ed25519");
    expect(reverted.notes).toEqual([]);
  });

  test("Windows: the service and the rule go in one script, and the keys with them", async () => {
    const home = await authorized();
    const ran: string[][] = [];
    const reverted = await revertSshAccess(platform({ os: "windows", env: "windows" }), {
      home,
      run: async (cmd) => {
        ran.push(cmd);
        return { ok: true, out: "" };
      },
    });

    expect(ran).toHaveLength(1);
    const script = ran[0]?.[3] ?? "";
    expect(ran[0]?.[0]).toBe("powershell.exe");
    // All three clauses of the sentence, in the one act: stopped,
    // disabled, and the rule this project added deleted by the name it
    // added it under.
    expect(script).toContain("Stop-Service sshd");
    expect(script).toContain("Set-Service -Name sshd -StartupType Disabled");
    expect(script).toContain("Remove-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'");
    expect(reverted.removedKeys).toHaveLength(2);
  });

  test("the rule is deleted under the name the install added it under", () => {
    // Two texts, one string. A rename in either copy alone leaves a
    // converged machine holding an open port nothing knows how to close.
    const source = readFileSync("src/ssh-server.ts", "utf8");
    const added = source.match(/New-NetFirewallRule[\s\S]{0,200}?-Name '([^']+)'/);
    const removed = source.match(/Remove-NetFirewallRule -Name '([^']+)'/);
    expect(source).toContain("New-NetFirewallRule -Name 'OpenSSH-Server-In-TCP'");
    expect(removed?.[1]).toBe("OpenSSH-Server-In-TCP");
    void added;
  });

  test("a service that will not stop still takes the keys with it, and says which half failed", async () => {
    const home = await authorized();
    const reverted = await revertSshAccess(platform(), {
      home,
      run: async (cmd) =>
        cmd.includes("disable") ? { ok: false, out: "sudo: a password is required" } : { ok: true, out: "" },
    });

    // Half-reverted is a real state, and a machine in it has to be able
    // to say which half. The keys come out either way: a service that
    // outlives the removal must not also outlive the authorization.
    expect(reverted.notes[0]).toContain("still enabled");
    expect(reverted.removedKeys).toHaveLength(2);
  });

  test("and uninstall names all three before it does any of it", async () => {
    const home = await authorized();
    const removal = sshAccessRemoval(platform(), { home, run: async () => ({ ok: true, out: "" }) });
    expect(removal.tool).toBe("ssh-server");
    // The sentence `red-dev uninstall` prints while asking. Three
    // clauses, because reverting two of the three is how a machine ends
    // up still listening for a key that is no longer there.
    expect(removal.how).toContain("systemctl disable --now ssh");
    expect(removal.how).toContain("authorized keys");
    expect(
      sshAccessRemoval(platform({ os: "windows", env: "windows" })).how,
    ).toContain("TCP 22 rule");

    await removal.run();
    expect(readFileSync(authorizedKeysPath(home), "utf8")).not.toContain("ssh-rsa");
  });

  test("and `red-dev uninstall` offers it, which the manifest alone would not", () => {
    // The wiring, not the shape. `ssh-server` is a managed builtin, so
    // nothing probes for it and `removalFor` has no package to name —
    // it would be absent from the list a person picks from, and the
    // three-clause revert above would be code nobody could reach.
    const offered = removableTools(platform()).find((c) => c.tool.name === "ssh-server");
    expect(offered?.removal.how).toContain("authorized keys");
  });

  test("a machine that was never authorized reverts to itself", async () => {
    const home = freshHome();
    const reverted = await revertSshAccess(platform(), {
      home,
      run: async () => ({ ok: true, out: "" }),
    });
    expect(reverted.removedKeys).toEqual([]);
    expect(existsSync(authorizedKeysPath(home))).toBe(false);
  });
});
