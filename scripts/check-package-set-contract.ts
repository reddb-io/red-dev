/**
 * Does this red-dev accept the package set red-skills actually publishes?
 *
 * red-dev does not import the publisher's verifier; it transcribes it
 * (see the note at the top of src/red-skills-set.ts). Two independent
 * implementations of one contract is the property, not the accident —
 * a verifier that came out of the release it judges decides nothing.
 * What two implementations need is an alarm when they disagree, and
 * there was none: red-skills 4.0 moved the manifest to
 * `red.package-set.v2`, every red-dev in the field refused every 4.x
 * set with "manifest shape or key order is not canonical", and the
 * first thing that noticed was a person's machine, hours later, with a
 * message that reads like a corrupt download.
 *
 * This is that alarm. It fetches the newest published manifest and asks
 * the parser this binary ships whether it can read it. Run in CI on
 * every push and on a schedule, so the day the contract moves the red
 * appears here rather than on somebody's workstation.
 *
 * It deliberately does not verify a signature or download the set: the
 * question is only "can this red-dev still read what they publish", and
 * keeping it to one small JSON file is what makes it cheap enough to
 * run on a timer.
 *
 *   bun scripts/check-package-set-contract.ts [--tag v4.0.1]
 *
 * Exit 0 when the manifest parses, 1 when it does not, and 2 when the
 * release could not be reached — an offline runner is not a contract
 * that broke, and it must not be reported as one.
 */

import { parsePackageSetManifest, PACKAGE_SET_SCHEMA_V1, PACKAGE_SET_SCHEMA_V2 } from "../src/red-skills-set.ts";

const REPO = "reddb-io/red-skills";
const ASSET = "package-set.manifest.json";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

/** The tag to check: an explicit one, or whatever `latest` redirects to. */
async function resolveTag(): Promise<string> {
  const explicit = arg("tag");
  if (explicit) return explicit;
  // The redirect rather than the API: no token, no rate limit, and the
  // same answer an operator's installer would get.
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET releases/latest -> ${res.status}`);
  const tag = res.url.split("/").pop();
  if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) throw new Error(`could not read a tag from ${res.url}`);
  return tag;
}

async function main(): Promise<number> {
  let tag: string;
  let bytes: string;
  try {
    tag = await resolveTag();
    const url = `https://github.com/${REPO}/releases/download/${tag}/${ASSET}`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    bytes = await res.text();
  } catch (err) {
    console.error(`unreachable: ${(err as Error).message}`);
    console.error("the contract was not checked; this is not a contract failure");
    return 2;
  }

  const parsed = parsePackageSetManifest(bytes);
  if (!parsed.ok) {
    console.error(`red-skills ${tag} publishes a package set this red-dev cannot read:`);
    console.error(`  ${parsed.reason}`);
    console.error("");
    console.error(`This red-dev reads ${PACKAGE_SET_SCHEMA_V1} and ${PACKAGE_SET_SCHEMA_V2}.`);
    console.error("Transcribe the publisher's scripts/verify-package-set.mjs from that release");
    console.error("into src/red-skills-set.ts — do not import it, and do not run it.");
    console.error("Until then every machine refuses every set that release publishes.");
    return 1;
  }

  const m = parsed.manifest;
  console.log(`ok  red-skills ${tag}: ${m.schema}, ${m.artifacts.length} artifact(s)`);
  if (m.version) console.log(`    version ${m.version}, channel ${m.channel}, targets ${m.targets?.join(", ")}`);
  return 0;
}

process.exit(await main());
