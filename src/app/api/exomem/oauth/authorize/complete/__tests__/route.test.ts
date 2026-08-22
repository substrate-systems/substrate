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

  // `readOAuthForm` answers an unrecognized field, a duplicate key and a
  // malformed body identically, so without the field names a rejection here
  // says only "the form was wrong". An extra field injected by a password
  // manager or a browser extension is a real way to reach this gate, and it
  // would otherwise be indistinguishable from a corrupt request.
  it("names an unexpected form field without recording its value", async () => {
    const errors: unknown[] = [];
    const restore = console.error;
    console.error = (value: unknown) => errors.push(value);
    let response: Response;
    try {
      const { POST } = await import("../route");
      response = await POST(
        new Request("https://substratesystems.io/api/exomem/oauth/authorize/complete", {
          method: "POST",
          headers: {
            origin: "https://substratesystems.io",
            host: "substratesystems.io",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            nonce: "form-nonce",
            confirmation: LIVE_HANDLE,
            autofill_extra: "a-value-that-must-not-be-logged",
          }).toString(),
        })
      );
    } finally {
      console.error = restore;
    }

    assert.equal(response!.status, 400);
    const record = errors.at(-1) as { stage?: string; field_names?: string } | undefined;
    assert.equal(record?.stage, "form");
    assert.ok(
      record?.field_names?.includes("autofill_extra"),
      "the unexpected field must be named so the cause is visible"
    );
    assert.ok(
      !JSON.stringify(record).includes("a-value-that-must-not-be-logged"),
      "field values must never reach the log"
    );
  });

  // What Chrome actually sends. The consent page declares `no-referrer`, and
  // under that policy a form POST carries `Origin: null` -- so the real browser
  // request never resembled the hand-built ones these tests were using, and the
  // origin gate refused every genuine Connect. Verbatim from the production log
  // of the 2026-08-22 window: origin 'null', sec-fetch-site 'same-origin'.
  it("accepts the real browser submission whose Origin was redacted to null", async () => {
    const { POST } = await import("../route");
    const response = await POST(
      new Request("https://substratesystems.io/api/exomem/oauth/authorize/complete", {
        method: "POST",
        headers: {
          origin: "null",
          host: "substratesystems.io",
          "sec-fetch-site": "same-origin",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ nonce: "form-nonce", confirmation: LIVE_HANDLE }).toString(),
      })
    );

    assert.equal(response.status, 303, "a same-origin consent submission must mint the code");
    assert.equal(
      response.headers.get("location"),
      "https://client.example/callback?code=authorization-code"
    );
    assert.equal(attachCalls, 1);
  });

  // The gate still has to refuse a genuine cross-site POST, which is the whole
  // reason it exists. Sec-Fetch-Site is a forbidden header, so a hostile page
  // cannot claim same-origin -- the browser stamps this one itself.
  it("still refuses a cross-site submission that carries a plausible Origin", async () => {
    const errors: unknown[] = [];
    const restore = console.error;
    console.error = (value: unknown) => errors.push(value);
    let response: Response;
    try {
      const { POST } = await import("../route");
      response = await POST(
        new Request("https://substratesystems.io/api/exomem/oauth/authorize/complete", {
          method: "POST",
          headers: {
            origin: "https://substratesystems.io",
            host: "substratesystems.io",
            "sec-fetch-site": "cross-site",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ nonce: "form-nonce", confirmation: LIVE_HANDLE }).toString(),
        })
      );
    } finally {
      console.error = restore;
    }

    assert.equal(response!.status, 400);
    assert.equal((errors.at(-1) as { stage?: string })?.stage, "origin");
    assert.equal(attachCalls, 0, "a cross-site post must not mint an authorization");
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
