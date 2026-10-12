import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifyTurnstileToken, type TurnstileDependencies } from "../turnstile";

// A production-shaped secret: Cloudflare's test secrets skip the hostname and
// action checks.
const SECRET = "0x4AAAAAAAexample-production-secret";
const TEST_SECRET = "1x0000000000000000000000000000000AA";

function siteverifyAnswering(body: Record<string, unknown>, status = 200): typeof fetch {
  return (async () => Response.json(body, { status })) as typeof fetch;
}

function dependencies(overrides: Partial<TurnstileDependencies>): Partial<TurnstileDependencies> {
  return {
    fetch: siteverifyAnswering({ success: true, action: "start", hostname: "substratesystems.io" }),
    secretKey: SECRET,
    deploymentEnvironment: "production",
    expectedHostname: () => "substratesystems.io",
    logError: () => undefined,
    ...overrides,
  };
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
        dependencies({
          fetch: siteverifyAnswering({ success: true, "error-codes": [], ...answer }),
        })
      );
      assert.equal(verdict, "failed");
    });
  }

  it("passes a token for the start form on our hostname", async () => {
    const verdict = await verifyTurnstileToken(
      { token: "token-from-the-widget", remoteIp: "203.0.113.20" },
      dependencies({
        fetch: siteverifyAnswering({
          success: true,
          "error-codes": [],
          action: "start",
          hostname: "substratesystems.io",
        }),
      })
    );
    assert.equal(verdict, "passed");
  });

  // A replayed token must be refused, not waved through as "cannot run".
  // (An invalid token is covered end to end by the start route's test.)
  it("fails closed on a token that was already used", async () => {
    const verdict = await verifyTurnstileToken(
      { token: "token-from-the-widget", remoteIp: null },
      dependencies({
        fetch: siteverifyAnswering({ success: false, "error-codes": ["timeout-or-duplicate"] }),
      })
    );
    assert.equal(verdict, "failed");
  });

  // One posture when the check cannot run: the rate limits alone, logged at
  // error level, never a refusal of every sign-in.
  for (const [label, overrides] of [
    ["Cloudflare answers 5xx", { fetch: siteverifyAnswering({}, 503) }],
    [
      "Cloudflare reports an internal error",
      { fetch: siteverifyAnswering({ success: false, "error-codes": ["internal-error"] }) },
    ],
    [
      "Cloudflare cannot be reached",
      {
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      },
    ],
    ["the secret is missing", { secretKey: undefined }],
    [
      "Cloudflare rejects the secret",
      {
        fetch: siteverifyAnswering({ success: false, "error-codes": ["invalid-input-secret"] }),
      },
    ],
    ["production has a test secret", { secretKey: TEST_SECRET }],
  ] as const) {
    it(`falls back to the rate limits and logs an error when ${label}`, async () => {
      const logged: string[] = [];
      const verdict = await verifyTurnstileToken(
        { token: "token-from-the-widget", remoteIp: null },
        dependencies({ ...overrides, logError: (line) => logged.push(line) })
      );
      assert.equal(verdict, "unavailable");
      assert.equal(logged.length, 1);
      assert.equal(logged[0]!.includes("token-from-the-widget"), false);
    });
  }
});
