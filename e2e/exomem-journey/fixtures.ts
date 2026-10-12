// The journey specs' one fixture: each test arrives from its own network address, the
// way separate people do, so the server's per-address limits (start, reviewer sign-in)
// count each test on its own instead of the whole run as one visitor. The addresses are
// from 198.18.0.0/15, which RFC 2544 reserves for testing.

import { randomInt } from "node:crypto";
import { test as base } from "@playwright/test";

export const test = base.extend<{ networkAddress: string }>({
  networkAddress: [
    async ({ context }, use) => {
      const address = `198.18.${randomInt(256)}.${randomInt(1, 255)}`;
      await context.setExtraHTTPHeaders({ "x-forwarded-for": address });
      await use(address);
    },
    { auto: true },
  ],
});

export { expect } from "@playwright/test";
