import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";

const SESSION_TOKEN = Buffer.alloc(32, 0x21).toString("base64url");
const CSRF_TOKEN = Buffer.alloc(32, 0x22).toString("base64url");
const MAGIC_CHALLENGE = Buffer.alloc(32, 0x23).toString("base64url");
const SENTINEL = "route-email-token-credential-path-query-sentinel";
let inviteCalls = 0;
let inviteError: Error | null = null;
let magicRequests = 0;
let magicRedeems = 0;
let continuationLookups = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/access", {
    namedExports: {
      redeemInvite: async () => {
        inviteCalls += 1;
        if (inviteError) throw inviteError;
        return {
          userId: "018f2d91-7c42-7000-8000-000000000021",
          tenantId: "018f2d91-7c42-7000-8000-000000000022",
          sessionId: "018f2d91-7c42-7000-8000-000000000023",
          operationId: "018f2d91-7c42-7000-8000-000000000024",
          sessionToken: SESSION_TOKEN,
          sessionDigest: Buffer.alloc(32),
          csrfToken: CSRF_TOKEN,
          csrfDigest: Buffer.alloc(32),
          expiresAt: new Date("2026-07-14T00:00:00.000Z"),
        };
      },
      requestMagicLink: async (input: { browserChallengeDigest: Buffer }) => {
        assert.equal(input.browserChallengeDigest.length, 32);
        magicRequests += 1;
        return { accepted: true };
      },
      redeemMagicLink: async (input: { browserChallenge: string }) => {
        magicRedeems += 1;
        if (input.browserChallenge !== MAGIC_CHALLENGE) {
          throw new ExomemHostedError({
            code: "ACCESS_TOKEN_INVALID",
            status: 401,
            message: "the access link is invalid or unavailable",
          });
        }
        return {
          userId: "018f2d91-7c42-7000-8000-000000000021",
          tenantId: "018f2d91-7c42-7000-8000-000000000022",
          sessionId: "018f2d91-7c42-7000-8000-000000000023",
          sessionToken: SESSION_TOKEN,
          sessionDigest: Buffer.alloc(32),
          csrfToken: CSRF_TOKEN,
          csrfDigest: Buffer.alloc(32),
          expiresAt: new Date("2026-07-14T00:00:00.000Z"),
        };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/oauth-store", {
    namedExports: {
      admitFirstOAuthInviteAtomic: async () => null,
      createAuthorizationTransaction: async () => null,
      findPendingOAuthAuthorization: async () => {
        continuationLookups += 1;
        return null;
      },
      resolveApprovedOAuthClient: async () => null,
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  inviteCalls = 0;
  inviteError = null;
  magicRequests = 0;
  magicRedeems = 0;
  continuationLookups = 0;
});

function post(
  path: string,
  body: Record<string, unknown>,
  cookie?: string
): import("next/server").NextRequest {
  return new Request(`https://substratesystems.io${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "substratesystems.io",
      origin: "https://substratesystems.io",
      "x-forwarded-for": "203.0.113.10",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as import("next/server").NextRequest;
}

describe("Exomem access routes", () => {
  it("redeems an invite into product-specific session and CSRF cookies", async () => {
    const { POST } = await import("../redeem/route");
    const response = await POST(post("/api/exomem/access/redeem", { token: SENTINEL }));
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie().join("\n");
    assert.match(cookies, /exomem_session=/);
    assert.match(cookies, /exomem_csrf=/);
    assert.match(cookies, /HttpOnly/);
    assert.match(cookies, /SameSite=lax/i);
    const body = await response.text();
    assert.equal(body.includes(SESSION_TOKEN), false);
    assert.equal(body.includes(CSRF_TOKEN), false);
    assert.equal(body.includes(SENTINEL), false);
  });

  it("rejects attempts to replace an invite's bound email", async () => {
    const { POST } = await import("../redeem/route");
    const response = await POST(
      post("/api/exomem/access/redeem", {
        token: SENTINEL,
        email: "override@example.com",
      })
    );
    assert.equal(response.status, 400);
    assert.equal(inviteCalls, 0);
  });

  it("rejects an incomplete OAuth continuation before looking it up", async () => {
    const { POST } = await import("../redeem/route");
    const response = await POST(
      post(
        "/api/exomem/access/redeem",
        { token: SENTINEL },
        `exomem_oauth_tx=${Buffer.alloc(32, 0x24).toString("base64url")}`
      )
    );
    assert.equal(response.status, 400);
    assert.equal(inviteCalls, 0);
    assert.equal(continuationLookups, 0);
  });

  it("rejects login CSRF, form-compatible content, and padded redemption bodies", async () => {
    const { POST: redeemInviteRoute } = await import("../redeem/route");
    const { POST: redeemMagicRoute } = await import("../magic-link/redeem/route");
    const attacks = [
      new Request("https://substratesystems.io/api/exomem/access/redeem", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          host: "substratesystems.io",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ token: SENTINEL, padding: "form-compatible" }),
      }),
      new Request("https://substratesystems.io/api/exomem/access/redeem", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "substratesystems.io",
          origin: "https://attacker.example",
        },
        body: JSON.stringify({ token: SENTINEL }),
      }),
      new Request("https://substratesystems.io/api/exomem/access/redeem", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "substratesystems.io",
          origin: "https://substratesystems.io",
        },
        body: JSON.stringify({ token: SENTINEL, padding: true }),
      }),
    ] as unknown as import("next/server").NextRequest[];

    for (const request of attacks) {
      const response = await redeemInviteRoute(request);
      assert.equal(response.status, request === attacks[2] ? 400 : 403);
      assert.equal(response.headers.getSetCookie().length, 0);
    }
    const magic = await redeemMagicRoute(attacks[1]);
    assert.equal(magic.status, 403);
    const magicCookies = magic.headers.getSetCookie().join("\n");
    assert.match(magicCookies, /exomem_magic_challenge=.*Max-Age=0/i);
    assert.doesNotMatch(magicCookies, /exomem_session=/i);
    assert.equal(inviteCalls, 0);
  });

  it("returns the same non-enumerating magic-link acknowledgement", async () => {
    const { POST } = await import("../magic-link/route");
    const known = await POST(post("/api/exomem/access/magic-link", { email: "known@example.com" }));
    const unknown = await POST(
      post("/api/exomem/access/magic-link", { email: "unknown@example.com" })
    );
    const knownBody = (await known.json()) as Record<string, unknown>;
    const unknownBody = (await unknown.json()) as Record<string, unknown>;
    delete knownBody.requestId;
    delete unknownBody.requestId;
    assert.equal(known.status, unknown.status);
    assert.deepEqual(knownBody, unknownBody);
    assert.equal(magicRequests, 2);
    for (const response of [known, unknown]) {
      const cookies = response.headers.getSetCookie().join("\n");
      assert.match(cookies, /exomem_magic_challenge=/);
      assert.match(cookies, /HttpOnly/i);
      assert.match(cookies, /SameSite=lax/i);
      assert.match(cookies, /Path=\/api\/exomem\/access\/magic-link/i);
    }
  });

  it("requires a browser challenge, creates a session once, and clears the challenge", async () => {
    const { POST } = await import("../magic-link/redeem/route");
    const missing = await POST(post("/api/exomem/access/magic-link/redeem", { token: SENTINEL }));
    assert.equal(missing.status, 401);
    assert.equal(magicRedeems, 0);
    assert.match(missing.headers.getSetCookie().join("\n"), /exomem_magic_challenge=.*Max-Age=0/i);

    const redeemed = await POST(
      post(
        "/api/exomem/access/magic-link/redeem",
        { token: SENTINEL },
        `exomem_magic_challenge=${MAGIC_CHALLENGE}`
      )
    );
    assert.equal(redeemed.status, 200);
    assert.equal(magicRedeems, 1);
    const cookies = redeemed.headers.getSetCookie().join("\n");
    assert.match(cookies, /exomem_session=/);
    assert.match(cookies, /exomem_magic_challenge=.*Max-Age=0/i);
  });

  it("maps consumed and expired token replays to the same stable failure", async () => {
    inviteError = new ExomemHostedError({
      code: "ACCESS_TOKEN_INVALID",
      status: 401,
      message: "the access link is invalid or unavailable",
    });
    const { POST } = await import("../redeem/route");
    const response = await POST(post("/api/exomem/access/redeem", { token: SENTINEL }));
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "ACCESS_TOKEN_INVALID");
    assert.equal(JSON.stringify(body).includes(SENTINEL), false);
  });
});
