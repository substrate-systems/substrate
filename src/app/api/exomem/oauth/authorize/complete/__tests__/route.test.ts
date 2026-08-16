import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";

const LIVE_TRANSACTION = "live-transaction-token";
const LIVE_HANDLE = "handle-for-live-transaction";
const STALE_HANDLE = "handle-for-an-earlier-transaction";

let nonceValid = true;
let attachCalls = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/oauth-continuity", {
    namedExports: {
      resolveOAuthContinuation: async () => ({ clientId: "client-1" }),
      oauthContinuationDigest: () => Buffer.alloc(32, 1),
      oauthContinuationToken: () => LIVE_TRANSACTION,
      oauthConfirmationHandle: (transaction: string) => {
        assert.equal(transaction, LIVE_TRANSACTION);
        return LIVE_HANDLE;
      },
      matchesOAuthConfirmationHandle: (_transaction: string, confirmation: string) =>
        confirmation === LIVE_HANDLE,
      validateOAuthContinuationNonce: () => nonceValid,
      mintContinuationCode: () => ({
        code: "authorization-code",
        codeDigest: Buffer.alloc(32, 2),
        codeExpiresAt: new Date("2026-08-16T20:00:00.000Z"),
      }),
      authorizationRedirect: (_continuation: unknown, code: string) =>
        new URL(`https://client.example/callback?code=${code}`),
      clearOAuthContinuationCookie: () => {},
    },
  });
  mock.module("@/lib/exomem-hosted/public-origin", {
    namedExports: { exomemPublicBaseUrlFromEnv: () => "https://substratesystems.io" },
  });
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: { resolveExomemSession: async () => ({ id: "session-1" }) },
  });
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      attachExistingOwnerAuthorizationAtomic: async () => {
        attachCalls += 1;
        return true;
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  nonceValid = true;
  attachCalls = 0;
});

function post(confirmation: string, nonce = "form-nonce"): Request {
  return new Request("https://substratesystems.io/api/exomem/oauth/authorize/complete", {
    method: "POST",
    headers: {
      origin: "https://substratesystems.io",
      host: "substratesystems.io",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ nonce, confirmation }).toString(),
  });
}

describe("POST /api/exomem/oauth/authorize/complete", () => {
  it("sends a stale tab back to a freshly rendered consent page instead of a dead end", async () => {
    const { POST } = await import("../route");
    const response = await POST(post(STALE_HANDLE));

    // The 2026-08-16 failure: a reviewer sign-in re-renders the page, so a second
    // Exomem window left open still holds the previous transaction's confirmation.
    // That used to answer `400 invalid_request` with no route forward.
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      `https://substratesystems.io/exomem/authorize?confirmation=${encodeURIComponent(LIVE_HANDLE)}`
    );
    assert.equal(attachCalls, 0, "a stale tab must not mint an authorization");
  });

  it("still refuses a bad nonce against a current confirmation", async () => {
    nonceValid = false;
    const { POST } = await import("../route");
    const response = await POST(post(LIVE_HANDLE));

    // The nonce is this form's CSRF defence. Staleness is diagnosed by the
    // confirmation; a nonce that fails against a *current* confirmation is not
    // staleness and must stay a hard failure.
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
    assert.equal(attachCalls, 0);
  });

  it("mints the code when confirmation and nonce both match the live transaction", async () => {
    const { POST } = await import("../route");
    const response = await POST(post(LIVE_HANDLE));

    assert.equal(response.status, 303);
    assert.equal(
      response.headers.get("location"),
      "https://client.example/callback?code=authorization-code"
    );
    assert.equal(attachCalls, 1);
  });
});
