import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ROUTER_HOST,
  DEFAULT_ROUTER_PORT,
  LEGACY_ROUTER_SERVICE,
  ROUTER_SERVICE,
  routerEnabled,
  routerHost,
  routerPort,
  routerWrapper,
} from "./red-router.ts";

describe("RedRouter service contract", () => {
  test("uses the official package defaults and service name", () => {
    expect(ROUTER_SERVICE).toBe("red-router.service");
    expect(LEGACY_ROUTER_SERVICE).toBe("red-dev-9router.service");
    expect(routerPort({})).toBe(DEFAULT_ROUTER_PORT);
    expect(routerHost({})).toBe(DEFAULT_ROUTER_HOST);
    expect(routerPort({ RED_ROUTER_PORT: "26000" })).toBe(26000);
    expect(routerHost({ RED_ROUTER_HOST: "0.0.0.0" })).toBe("0.0.0.0");
    expect(routerEnabled({ RED_ROUTER: "0" })).toBe(false);
  });

  test("Windows starts the official command in tray mode", () => {
    expect(routerWrapper("C:\\mise.exe", 25050, "127.0.0.1")).toContain(
      '"C:\\mise.exe" exec red-router -- red-router -t --skip-update -n -p 25050 -H "127.0.0.1"',
    );
  });
});
