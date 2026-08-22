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

  // Each gate below answers the same bare `invalid_request`, so the only way to
  // tell them apart after the fact is the server log. On 2026-08-22 a 400 from
  // this route could not be attributed at all, and diagnosing it cost a live
  // promotion window. The response must stay identical; the log must not.
  it("names which gate rejected the request, without logging any secret", async () => {
    nonceValid = false;
    const errors: unknown[] = [];
    const restore = console.error;
    console.error = (value: unknown) => errors.push(value);
    let response: Response;
    try {
      const { POST } = await import("../route");
      response = await POST(post(LIVE_HANDLE, "a-secret-form-nonce"));
    } finally {
      console.error = restore;
    }

    // The caller still learns nothing it did not already know.
    assert.equal(response!.status, 400);
    assert.deepEqual(await response!.json(), { error: "invalid_request" });

    const record = errors.at(-1) as { event?: string; stage?: string } | undefined;
    assert.equal(record?.event, "exomem_oauth_authorize_complete_rejection");
    assert.equal(record?.stage, "nonce", "the failing gate must be named for the operator");

    // Presence and shape only: a diagnostic that echoed the nonce, the
    // confirmation handle or the transaction cookie would turn the server log
    // into a place where authorization material is stored in the clear.
    const serialized = JSON.stringify(record);
    assert.ok(
      !serialized.includes("a-secret-form-nonce"),
      "the form nonce must never reach the log"
    );
    assert.ok(!serialized.includes(LIVE_HANDLE), "the confirmation handle must never reach the log");
    assert.ok(
      !serialized.includes(LIVE_TRANSACTION),
      "the transaction token must never reach the log"
    );
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
