import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";

const SESSION_TOKEN = Buffer.alloc(32, 0x21).toString("base64url");
const CSRF_TOKEN = Buffer.alloc(32, 0x22).toString("base64url");
const MAGIC_CHALLENGE = Buffer.alloc(32, 0x23).toString("base64url");
const SENTINEL = "route-email-token-credential-path-query-sentinel";
let cloudInviteError: Error | null = null;
let cloudInvitePaid = false;
let startRequests = 0;
let magicRedeems = 0;
let continuationLookups = 0;
let cloudInviteCalls = 0;
let cloudOAuthAdmissionCalls = 0;
let rateLimitAllowed = true;

before(async () => {
  // The redemption limit is a database bucket; here it answers as each test sets it.
  const actualRateLimit = await import("@/lib/exomem-hosted/rate-limit");
  mock.module("@/lib/exomem-hosted/rate-limit", {
    namedExports: { ...actualRateLimit, takeExomemRateLimit: async () => rateLimitAllowed },
  });
  mock.module("@/lib/exomem-hosted/cloud-admission", {
    namedExports: {
      redeemCloudInvite: async () => {
        cloudInviteCalls += 1;
        if (cloudInviteError) throw cloudInviteError;
        return {
          userId: "018f2d91-7c42-7000-8000-000000000031",
          tenantId: "018f2d91-7c42-7000-8000-000000000032",
          sessionId: "018f2d91-7c42-7000-8000-000000000033",
          cellId: "aaaaaaaaaaaaaaaa",
          paid: cloudInvitePaid,
          sessionToken: SESSION_TOKEN,
          sessionDigest: Buffer.alloc(32),
          csrfToken: CSRF_TOKEN,
          csrfDigest: Buffer.alloc(32),
          expiresAt: new Date("2026-07-14T00:00:00.000Z"),
        };
      },
      admitFirstCloudOAuthInviteAtomic: async () => {
        cloudOAuthAdmissionCalls += 1;
        return null;
      },
    },
  });
  mock.module("@/lib/exomem-hosted/access", {
    namedExports: {
      requestStart: async () => {
        startRequests += 1;
        return { accepted: true };
      },
      redeemMagicLink: async (input: {
        browserChallenge: string | null;
        expectedEmail?: string;
      }) => {
        magicRedeems += 1;
        if (
          input.expectedEmail !== undefined
            ? input.expectedEmail !== "owner@example.com"
            : input.browserChallenge !== MAGIC_CHALLENGE
        ) {
          throw new ExomemHostedError({
            code:
              input.expectedEmail === undefined
                ? "EMAIL_CONFIRMATION_REQUIRED"
                : "ACCESS_TOKEN_INVALID",
            status: 401,
            message: "the access link is invalid or unavailable",
          });
        }
        return {
          userId: "018f2d91-7c42-7000-8000-000000000021",
          tenantId: "018f2d91-7c42-7000-8000-000000000022",
          sessionId: "018f2d91-7c42-7000-8000-000000000023",
          browserChallengeMatched: input.browserChallenge === MAGIC_CHALLENGE,
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
      createAuthorizationTransaction: async () => null,
      findPendingOAuthAuthorization: async () => {
        continuationLookups += 1;
        return null;
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  cloudInviteError = null;
  cloudInvitePaid = false;
  startRequests = 0;
  magicRedeems = 0;
  continuationLookups = 0;
  cloudInviteCalls = 0;
  cloudOAuthAdmissionCalls = 0;
  rateLimitAllowed = true;
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
  it("does not admit an anonymous visitor through the retired self-serve route", async () => {
    const { POST } = await import("../request/route");

    const response = await POST();

    assert.equal(response.status, 410);
    assert.equal(startRequests, 0);
  });

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

  it("redeems a plain invite through redeemCloudInvite without an OAuth admission", async () => {
    const { POST } = await import("../redeem/route");
    const response = await POST(post("/api/exomem/access/redeem", { token: SENTINEL }));
    assert.equal(response.status, 200);
    assert.equal(cloudInviteCalls, 1);
    assert.equal(cloudOAuthAdmissionCalls, 0);
  });

  it("answers a network over its redemption limit with 429, before looking up the invite", async () => {
    rateLimitAllowed = false;
    const { POST } = await import("../redeem/route");
    const response = await POST(post("/api/exomem/access/redeem", { token: SENTINEL }));
    assert.equal(response.status, 429);
    assert.equal(cloudInviteCalls, 0);
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
    assert.equal(cloudInviteCalls, 0);
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
    assert.equal(cloudInviteCalls, 0);
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
    assert.equal(magic.cookies.get("exomem_magic_challenge")?.value, "");
    assert.equal(cloudInviteCalls, 0);
  });

  it("refuses a sign-in request on the earlier path without a Turnstile token", async () => {
    const previous = process.env.EXOMEM_TURNSTILE_SECRET_KEY;
    // Cloudflare's documented always-pass test secret: only the missing token
    // can fail this request.
    process.env.EXOMEM_TURNSTILE_SECRET_KEY = "1x0000000000000000000000000000000AA";
    try {
      const { POST } = await import("../magic-link/route");
      const response = await POST(
        post("/api/exomem/access/magic-link", { email: "known@example.com" })
      );
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { success: false, error: "challenge_failed" });
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.equal(startRequests, 0);
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_TURNSTILE_SECRET_KEY;
      else process.env.EXOMEM_TURNSTILE_SECRET_KEY = previous;
    }
  });

  it("sends a paid web redemption on to the setup journey", async () => {
    cloudInvitePaid = true;
    const { POST } = await import("../redeem/route");
    const response = await POST(post("/api/exomem/access/redeem", { token: SENTINEL }));
    assert.equal(response.status, 200);
    const body = (await response.json()) as { destination: string };
    assert.equal(body.destination, "/exomem/setup");
  });

  it("asks for email without proof, and retains the browser challenge fast path", async () => {
    const { POST } = await import("../magic-link/redeem/route");
    const missing = await POST(post("/api/exomem/access/magic-link/redeem", { token: SENTINEL }));
    assert.equal(missing.status, 401);
    assert.equal(magicRedeems, 1);
    assert.match(missing.headers.getSetCookie().join("\n"), /exomem_magic_challenge=.*Max-Age=0/i);

    const redeemed = await POST(
      post(
        "/api/exomem/access/magic-link/redeem",
        { token: SENTINEL },
        `exomem_magic_challenge=${MAGIC_CHALLENGE}`
      )
    );
    assert.equal(redeemed.status, 200);
    assert.equal(magicRedeems, 2);
    const cookies = redeemed.headers.getSetCookie().join("\n");
    assert.match(cookies, /exomem_session=/);
    assert.match(cookies, /exomem_magic_challenge=.*Max-Age=0/i);
  });

  it("checks expected email and clears an unrelated OAuth continuation on cross-browser success", async () => {
    const { POST } = await import("../magic-link/redeem/route");
    const unrelated = `exomem_oauth_tx=${Buffer.alloc(32, 0x24).toString("base64url")}; exomem_oauth_form_nonce=${MAGIC_CHALLENGE}`;
    const wrong = await POST(
      post(
        "/api/exomem/access/magic-link/redeem",
        {
          token: SENTINEL,
          expectedEmail: "other@example.com",
        },
        `exomem_magic_challenge=${MAGIC_CHALLENGE}`
      )
    );
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).error.code, "ACCESS_TOKEN_INVALID");
    assert.doesNotMatch(wrong.headers.getSetCookie().join("\n"), /exomem_session=/);
    const completed = await POST(
      post(
        "/api/exomem/access/magic-link/redeem",
        {
          token: SENTINEL,
          expectedEmail: "owner@example.com",
        },
        unrelated
      )
    );
    assert.equal(completed.status, 200);
    const body = await completed.json();
    assert.equal(body.destination, "/exomem/home");
    assert.equal(JSON.stringify(body).includes("owner@example.com"), false);
    const cookies = completed.headers.getSetCookie().join("\n");
    assert.match(cookies, /exomem_session=/);
    assert.match(cookies, /exomem_oauth_tx=.*Max-Age=0/i);
    assert.match(cookies, /exomem_oauth_form_nonce=.*Max-Age=0/i);
    assert.equal(continuationLookups, 0);
  });

  it("rejects malformed expected email input before redemption", async () => {
    const { POST } = await import("../magic-link/redeem/route");
    for (const expectedEmail of [null, 12, {}]) {
      const response = await POST(
        post("/api/exomem/access/magic-link/redeem", { token: SENTINEL, expectedEmail })
      );
      assert.equal(response.status, 400);
      assert.doesNotMatch(response.headers.getSetCookie().join("\n"), /exomem_session=/);
    }
    assert.equal(magicRedeems, 0);
  });

  it("maps consumed and expired token replays to the same stable failure", async () => {
    cloudInviteError = new ExomemHostedError({
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
