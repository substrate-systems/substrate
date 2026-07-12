import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";

const SESSION_TOKEN = Buffer.alloc(32, 0x21).toString("base64url");
const CSRF_TOKEN = Buffer.alloc(32, 0x22).toString("base64url");
const SENTINEL = "route-email-token-credential-path-query-sentinel";
let inviteCalls = 0;
let inviteError: Error | null = null;
let magicRequests = 0;

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
      requestMagicLink: async () => {
        magicRequests += 1;
        return { accepted: true };
      },
      redeemMagicLink: async () => ({
        userId: "018f2d91-7c42-7000-8000-000000000021",
        tenantId: "018f2d91-7c42-7000-8000-000000000022",
        sessionId: "018f2d91-7c42-7000-8000-000000000023",
        sessionToken: SESSION_TOKEN,
        sessionDigest: Buffer.alloc(32),
        csrfToken: CSRF_TOKEN,
        csrfDigest: Buffer.alloc(32),
        expiresAt: new Date("2026-07-14T00:00:00.000Z"),
      }),
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  inviteCalls = 0;
  inviteError = null;
  magicRequests = 0;
});

function post(path: string, body: Record<string, unknown>): import("next/server").NextRequest {
  return new Request(`https://substratesystems.io${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
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
