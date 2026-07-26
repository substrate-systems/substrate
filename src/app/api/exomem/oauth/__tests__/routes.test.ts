import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { pkceS256 } from "@/lib/exomem-hosted/oauth";
import { readOAuthForm } from "@/lib/exomem-hosted/oauth-http";
import { digestSecret } from "@/lib/exomem-hosted/security";

const BASE_URL = "https://hosted.example.test";
const RESOURCE = `${BASE_URL}/api/exomem/mcp/v1`;
const CLIENT_ID = "https://client.example.test/client.json";
const REDIRECT_URI = "https://client.example.test/oauth/callback";
const VERIFIER = "v".repeat(43);
const SESSION_TOKEN = Buffer.alloc(32, 0x31).toString("base64url");
const FORM_SECRET = "oauth-route-content-sentinel";

type StoredContinuation = {
  transactionDigest: Buffer;
  stateDigest: Buffer;
  stateEnvelope: Record<string, unknown>;
  formNonceDigest: Buffer;
  continuationBinding: Buffer;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  pkceChallenge: string;
  expiresAt: Date;
};

const continuations = new Map<string, StoredContinuation>();
const attached: Array<{ sessionId: string; transactionDigest: Buffer; codeDigest: Buffer }> = [];
const tokenIssues: Array<Record<string, unknown>> = [];
const refreshes: Array<Record<string, unknown>> = [];
const revoked: Array<Record<string, unknown>> = [];
let tokenIssueResponses: Array<{ scopes: string[]; refreshInserted: boolean } | null> = [];
let refreshResponses: Array<{ scopes: string[] } | null> = [];
let admitCalls: Array<Record<string, unknown>> = [];

function digestKey(value: Buffer): string {
  return value.toString("base64url");
}

function storedContinuation(input: StoredContinuation) {
  return {
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scopes: input.scopes,
    stateEnvelope: input.stateEnvelope,
    stateDigest: input.stateDigest,
    formNonceDigest: input.formNonceDigest,
    continuationBinding: input.continuationBinding,
    pkceChallenge: input.pkceChallenge,
  };
}

before(() => {
  process.env.EXOMEM_CONTROL_PLANE_KEY = Buffer.alloc(32, 0x51).toString("base64url");
  process.env.EXOMEM_PUBLIC_BASE_URL = BASE_URL;
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      resolveApprovedOAuthClient: async (clientId: string) =>
        clientId === CLIENT_ID
          ? {
              id: "018f2d91-7c42-7000-8000-000000000041",
              clientId: CLIENT_ID,
              redirectUris: [REDIRECT_URI],
              admissionMode: "pinned",
            }
          : null,
      createAuthorizationTransaction: async (input: StoredContinuation) => {
        continuations.set(digestKey(input.transactionDigest), input);
        return { id: `transaction-${continuations.size}` };
      },
      findPendingOAuthAuthorization: async (transactionDigest: Buffer) => {
        const transaction = continuations.get(digestKey(transactionDigest));
        return transaction ? storedContinuation(transaction) : null;
      },
      attachExistingOwnerAuthorizationAtomic: async (input: {
        sessionId: string;
        transactionDigest: Buffer;
        codeDigest: Buffer;
      }) => {
        attached.push(input);
        return { grantId: "grant-1", tenantId: "tenant-1" };
      },
      issueOAuthTokensFromCodeAtomic: async (input: Record<string, unknown>) => {
        tokenIssues.push(input);
        const next = tokenIssueResponses.shift() ?? null;
        return next
          ? {
              grantId: "grant-1",
              familyId: "family-1",
              clientId: CLIENT_ID,
              resource: RESOURCE,
              scopes: next.scopes,
              refreshInserted: next.refreshInserted,
            }
          : null;
      },
      rotateOAuthRefreshTokenAtomic: async (input: Record<string, unknown>) => {
        refreshes.push(input);
        const next = refreshResponses.shift() ?? null;
        return next
          ? {
              grantId: "grant-1",
              familyId: "family-1",
              clientId: CLIENT_ID,
              resource: RESOURCE,
              scopes: next.scopes,
            }
          : null;
      },
      revokeOAuthTokenForClient: async (input: Record<string, unknown>) => {
        revoked.push(input);
      },
      admitFirstOAuthInviteAtomic: async (input: Record<string, unknown>) => {
        admitCalls.push(input);
        return { tenantId: "tenant-1", sessionId: "session-1", grantId: "grant-1" };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: {
      EXOMEM_RATE_LIMITS: { oauthAuthorizeIp: {}, oauthAuthorizeClient: {} },
      clientAddressKey: () => "203.0.113.10",
      takeExomemRateLimit: async () => true,
    },
  });
  mock.module("@/lib/exomem-hosted/public-origin", {
    namedExports: { exomemPublicBaseUrlFromEnv: () => BASE_URL },
  });
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({ id: "session-1" }),
      validatePublicAccessRequest: () => undefined,
      magicLinkChallengeFromRequest: () => "challenge",
      mintSessionMaterial: () => ({
        sessionToken: SESSION_TOKEN,
        sessionDigest: digestSecret(SESSION_TOKEN),
        csrfToken: Buffer.alloc(32, 0x32).toString("base64url"),
        csrfDigest: Buffer.alloc(32, 0x33),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
      applySessionCookies: (response: Response) => {
        response.headers.append("set-cookie", `exomem_session=${SESSION_TOKEN}; HttpOnly; Path=/`);
      },
      clearMagicLinkChallengeCookie: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/access", {
    namedExports: {
      redeemMagicLink: async () => ({
        sessionToken: SESSION_TOKEN,
        csrfToken: Buffer.alloc(32, 0x32).toString("base64url"),
        expiresAt: new Date("2026-08-01T00:00:00.000Z"),
      }),
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  continuations.clear();
  attached.length = 0;
  tokenIssues.length = 0;
  refreshes.length = 0;
  revoked.length = 0;
  admitCalls = [];
  tokenIssueResponses = [];
  refreshResponses = [];
});

function authorizeRequest(state = "client-state"): Request {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    resource: RESOURCE,
    scope: "exomem.read offline_access",
    state,
    code_challenge: pkceS256(VERIFIER),
    code_challenge_method: "S256",
  });
  return new Request(`${BASE_URL}/api/exomem/oauth/authorize?${query}`, {
    headers: { "x-forwarded-for": "203.0.113.10" },
  });
}

function cookie(response: Response, name: string): string {
  const match = response.headers
    .getSetCookie()
    .map((value) => value.match(new RegExp(`(?:^|;)\\s*${name}=([^;]+)`)))
    .find((value): value is RegExpMatchArray => !!value);
  assert.ok(match, `missing ${name} cookie`);
  return match[1];
}

function completionRequest(input: {
  transaction: string;
  nonce: string;
  confirmation: string;
}): Request {
  return new Request(`${BASE_URL}/api/exomem/oauth/authorize/complete`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: BASE_URL,
      host: "hosted.example.test",
      cookie: [
        `exomem_oauth_tx=${input.transaction}`,
        `exomem_oauth_form_nonce=${input.nonce}`,
        `exomem_session=${SESSION_TOKEN}`,
      ].join("; "),
    },
    body: new URLSearchParams({ nonce: input.nonce, confirmation: input.confirmation }),
  });
}

function confirmation(response: Response): string {
  const location = response.headers.get("location");
  assert.ok(location);
  const value = new URL(location).searchParams.get("confirmation");
  assert.ok(value);
  return value;
}

describe("Exomem OAuth routes", () => {
  it("redirects a valid authorization into an opaque, sealed continuation", async () => {
    const { GET } = await import("../authorize/route");
    const response = await GET(authorizeRequest());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const transaction = cookie(response, "exomem_oauth_tx");
    const nonce = cookie(response, "exomem_oauth_form_nonce");
    const handle = confirmation(response);
    assert.notEqual(handle, transaction);
    assert.equal(response.headers.get("location")?.includes(transaction), false);
    assert.equal(response.headers.getSetCookie().join("\n").includes("HttpOnly"), true);
    assert.equal(response.headers.getSetCookie().join("\n").includes("Secure"), true);
    const stored = continuations.get(digestKey(digestSecret(transaction)));
    assert.ok(stored);
    assert.deepEqual(
      {
        clientId: stored.clientId,
        redirectUri: stored.redirectUri,
        resource: stored.resource,
        scopes: stored.scopes,
        pkceChallenge: stored.pkceChallenge,
      },
      {
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        resource: RESOURCE,
        scopes: ["exomem.read", "offline_access"],
        pkceChallenge: pkceS256(VERIFIER),
      }
    );
    assert.notEqual(nonce, transaction);
  });

  it("keeps concurrent first continuations distinct and rejects a stale confirmation", async () => {
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/complete/route");
    const [first, second] = await Promise.all([
      GET(authorizeRequest("one")),
      GET(authorizeRequest("two")),
    ]);
    const firstTransaction = cookie(first, "exomem_oauth_tx");
    const secondTransaction = cookie(second, "exomem_oauth_tx");
    assert.notEqual(firstTransaction, secondTransaction);
    assert.notEqual(confirmation(first), confirmation(second));
    const stale = await POST(
      completionRequest({
        transaction: secondTransaction,
        nonce: cookie(second, "exomem_oauth_form_nonce"),
        confirmation: confirmation(first),
      })
    );
    assert.equal(stale.status, 400);
    assert.equal(attached.length, 0);
  });

  it("completes only the bound client redirect and state without exposing the continuation", async () => {
    const { GET } = await import("../authorize/route");
    const { POST } = await import("../authorize/complete/route");
    const started = await GET(authorizeRequest("bound-state"));
    const transaction = cookie(started, "exomem_oauth_tx");
    const complete = await POST(
      completionRequest({
        transaction,
        nonce: cookie(started, "exomem_oauth_form_nonce"),
        confirmation: confirmation(started),
      })
    );
    assert.equal(complete.status, 303);
    const redirect = new URL(complete.headers.get("location")!);
    assert.equal(redirect.origin + redirect.pathname, REDIRECT_URI);
    assert.equal(redirect.searchParams.get("state"), "bound-state");
    assert.ok(redirect.searchParams.get("code"));
    assert.equal(complete.headers.get("location")?.includes(transaction), false);
    assert.equal(attached.length, 1);
    assert.equal(attached[0].sessionId, "session-1");
    assert.deepEqual(attached[0].transactionDigest, digestSecret(transaction));
  });

  it("continues an authenticated browser, an invite, and a magic-link browser through the same transaction", async () => {
    const { GET } = await import("../authorize/route");
    const { POST: complete } = await import("../authorize/complete/route");
    const { POST: invite } = await import("../authorize/invite/route");
    const { POST: magic } = await import("../../access/magic-link/redeem/route");
    const started = await GET(authorizeRequest());
    const transaction = cookie(started, "exomem_oauth_tx");
    const nonce = cookie(started, "exomem_oauth_form_nonce");
    const existing = await complete(
      completionRequest({ transaction, nonce, confirmation: confirmation(started) })
    );
    assert.equal(existing.status, 303);
    const inviteStarted = await GET(authorizeRequest("invite-state"));
    const inviteTransaction = cookie(inviteStarted, "exomem_oauth_tx");
    const inviteNonce = cookie(inviteStarted, "exomem_oauth_form_nonce");
    const invited = await invite(
      new Request(`${BASE_URL}/api/exomem/oauth/authorize/invite`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          host: "hosted.example.test",
          cookie: `exomem_oauth_tx=${inviteTransaction}; exomem_oauth_form_nonce=${inviteNonce}`,
        },
        body: JSON.stringify({
          token: Buffer.alloc(32, 0x41).toString("base64url"),
          nonce: inviteNonce,
        }),
      })
    );
    assert.equal(invited.status, 303);
    assert.deepEqual(admitCalls[0].transactionDigest, digestSecret(inviteTransaction));
    const magicStarted = await GET(authorizeRequest("magic-state"));
    const magicTransaction = cookie(magicStarted, "exomem_oauth_tx");
    const magicResult = await magic(
      new Request(`${BASE_URL}/api/exomem/access/magic-link/redeem`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          host: "hosted.example.test",
          cookie: `exomem_oauth_tx=${magicTransaction}`,
        },
        body: JSON.stringify({ token: Buffer.alloc(32, 0x42).toString("base64url") }),
      }) as never
    );
    assert.equal(
      ((await magicResult.json()) as { destination: string }).destination,
      "/exomem/authorize"
    );
  });

  it("exchanges one authorization code with exact PKCE and resource binding", async () => {
    const { POST } = await import("../token/route");
    const code = Buffer.alloc(32, 0x61).toString("base64url");
    tokenIssueResponses = [{ scopes: ["exomem.read"], refreshInserted: true }, null];
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      code_verifier: VERIFIER,
      resource: RESOURCE,
    });
    const first = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(first.status, 200);
    assert.equal((await first.text()).includes(code), false);
    assert.equal(tokenIssues.length, 1);
    assert.equal(tokenIssues[0].clientId, CLIENT_ID);
    assert.equal(tokenIssues[0].redirectUri, REDIRECT_URI);
    assert.equal(tokenIssues[0].resource, RESOURCE);
    assert.deepEqual(tokenIssues[0].pkceChallenge, pkceS256(VERIFIER));
    const replay = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(replay.status, 400);
    assert.deepEqual(await replay.json(), { error: "invalid_grant" });
  });

  it("rotates refresh tokens and returns the same invalid-grant result for replay or current-policy denial", async () => {
    const { POST } = await import("../token/route");
    const refreshToken = Buffer.alloc(32, 0x71).toString("base64url");
    refreshResponses = [{ scopes: ["exomem.read"] }, null, null];
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
      resource: RESOURCE,
    });
    const success = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      })
    );
    assert.equal(success.status, 200);
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].clientId, CLIENT_ID);
    assert.equal(refreshes[0].resource, RESOURCE);
    assert.equal(JSON.stringify(refreshes[0]).includes(refreshToken), false);
    for (const scenario of ["replay", "policy-denied"]) {
      const denied = await POST(
        new Request(`${BASE_URL}/api/exomem/oauth/token`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body,
        })
      );
      assert.equal(denied.status, 400);
      assert.deepEqual(await denied.json(), { error: "invalid_grant" });
      assert.ok(scenario);
    }
  });

  it("returns RFC 7009 success for unknown revocation while invoking real-family revocation", async () => {
    const { POST } = await import("../revoke/route");
    for (const token of ["unknown", Buffer.alloc(32, 0x81).toString("base64url")]) {
      const response = await POST(
        new Request(`${BASE_URL}/api/exomem/oauth/revoke`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: CLIENT_ID, token }),
        })
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(revoked.length, 2);
    assert.equal(revoked[1].clientId, CLIENT_ID);
  });

  it("rejects oversized and non-form token requests without reflecting credentials", async () => {
    const { POST } = await import("../token/route");
    const response = await POST(
      new Request(`${BASE_URL}/api/exomem/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: FORM_SECRET }),
      })
    );
    assert.equal(response.status, 400);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.text()).includes(FORM_SECRET), false);
  });

  it("rejects unexpected and duplicate token form fields before token handling", async () => {
    await assert.rejects(
      () =>
        readOAuthForm(
          new Request(`${BASE_URL}/api/exomem/oauth/token`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=refresh_token&client_id=client&refresh_token=one&scope=exomem.read",
          }),
          ["grant_type", "client_id", "refresh_token", "resource"]
        ),
      /EXOMEM_INVALID_REQUEST/
    );
  });
});
