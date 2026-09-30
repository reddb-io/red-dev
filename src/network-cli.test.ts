import { test } from "bun:test";
import { verifyNetworkCli } from "./fixtures/network-cli.ts";

test("the CLI dispatches network and emits private JSON for both success and failure", async () => {
  await verifyNetworkCli([process.execPath, new URL("./main.ts", import.meta.url).pathname]);
}, 15_000);
