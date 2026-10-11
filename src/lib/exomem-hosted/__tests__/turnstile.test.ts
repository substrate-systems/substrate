import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyTurnstileToken } from "../turnstile";

// A production-shaped secret: Cloudflare's test secrets skip these checks.
const SECRET = "0x4AAAAAAAexample-production-secret";

function siteverifyAnswering(body: Record<string, unknown>): typeof fetch {
  return (async () => Response.json(body)) as typeof fetch;
}

describe("Turnstile siteverify", () => {
  // Cloudflare accepts a token for any widget on the account. Without these
  // checks, a token solved on another site or another form of ours would
  // open "Start with your email".
  for (const [label, answer] of [
    ["another action", { action: "login", hostname: "substratesystems.io" }],
    ["another hostname", { action: "start", hostname: "attacker.example" }],
  ] as const) {
    it(`fails a token Cloudflare accepted for ${label}`, async () => {
      const verdict = await verifyTurnstileToken(
        { token: "token-from-the-widget", remoteIp: null },
        {
          secretKey: SECRET,
          expectedHostname: () => "substratesystems.io",
          fetch: siteverifyAnswering({ success: true, "error-codes": [], ...answer }),
        }
      );
      assert.equal(verdict, "failed");
    });
  }

  it("passes a token for the start form on our hostname", async () => {
    const verdict = await verifyTurnstileToken(
      { token: "token-from-the-widget", remoteIp: "203.0.113.20" },
      {
        secretKey: SECRET,
        expectedHostname: () => "substratesystems.io",
        fetch: siteverifyAnswering({
          success: true,
          "error-codes": [],
          action: "start",
          hostname: "substratesystems.io",
        }),
      }
    );
    assert.equal(verdict, "passed");
  });
});
