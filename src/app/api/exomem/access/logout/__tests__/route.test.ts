import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { exomemErrors } from "@/lib/exomem-hosted/errors";

let resolveError: Error | null = null;
let csrfError: Error | null = null;
let revoked = 0;

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => {
        if (resolveError) throw resolveError;
        return {
          id: "018f2d91-7c42-7000-8000-000000000031",
          userId: "018f2d91-7c42-7000-8000-000000000032",
          tenantId: "018f2d91-7c42-7000-8000-000000000033",
          csrfDigest: Buffer.alloc(32),
          expiresAt: "2026-07-14T00:00:00.000Z",
        };
      },
      validateMutationRequest: () => {
        if (csrfError) throw csrfError;
      },
      revokeResolvedSession: async () => {
        revoked += 1;
      },
      clearSessionCookies: (response: import("next/server").NextResponse) => {
        response.cookies.set("exomem_session", "", { maxAge: 0, path: "/" });
        response.cookies.set("exomem_csrf", "", { maxAge: 0, path: "/" });
      },
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  resolveError = null;
  csrfError = null;
  revoked = 0;
});

function request(): import("next/server").NextRequest {
  return new Request("https://substratesystems.io/api/exomem/access/logout", {
    method: "POST",
    headers: {
      host: "substratesystems.io",
      origin: "https://substratesystems.io",
    },
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/exomem/access/logout", () => {
  it("revokes database state and clears both product cookies", async () => {
    const { POST } = await import("../route");
    const response = await POST(request());
    assert.equal(response.status, 200);
    assert.equal(revoked, 1);
    const cookies = response.headers.getSetCookie().join("\n");
    assert.match(cookies, /exomem_session=/);
    assert.match(cookies, /exomem_csrf=/);
    assert.match(cookies, /Max-Age=0/i);
  });

  it("rejects CSRF failure before revocation", async () => {
    csrfError = exomemErrors.csrfRejected();
    const { POST } = await import("../route");
    const response = await POST(request());
    assert.equal(response.status, 403);
    assert.equal(revoked, 0);
  });

  it("does not accept a non-Exomem session", async () => {
    resolveError = exomemErrors.sessionInvalid();
    const { POST } = await import("../route");
    const response = await POST(request());
    assert.equal(response.status, 401);
    assert.equal(revoked, 0);
  });
});
