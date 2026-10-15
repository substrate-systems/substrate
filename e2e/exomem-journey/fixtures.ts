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

/**
 * How long a step after Connect may take to appear. Connect lights the whole field before it
 * reports, about 2.5 s by design, and the journey runs on `next dev` with software rendering,
 * which can slow that animation's frames well past the default 5 s on a busy runner.
 */
export const AFTER_CONNECT_MS = 10_000;
