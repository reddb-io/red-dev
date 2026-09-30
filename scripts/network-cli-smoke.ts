import { resolve } from "node:path";
import { verifyNetworkCli } from "../src/fixtures/network-cli.ts";

const binary = process.argv[2];
if (!binary) throw new Error("usage: bun scripts/network-cli-smoke.ts <compiled-binary>");
await verifyNetworkCli([resolve(binary)]);
console.log("NETWORK CLI OK");
