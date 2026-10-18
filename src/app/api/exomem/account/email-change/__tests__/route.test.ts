import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import type { NextRequest } from "next/server";
import { __setExomemSqlForTests } from "@/lib/exomem-hosted/db";
import { digestSecret } from "@/lib/exomem-hosted/security";

const sessionToken = Buffer.alloc(32, 1).toString("base64url");
const csrf = Buffer.alloc(32, 2).toString("base64url");
let mutations: unknown[] = [];
before(() =>
  mock.module("@/lib/exomem-hosted/email-change", {
    namedExports: {
      requestExomemEmailChange: async (session: unknown, email: string) => {
        mutations.push({ session, email });
        return {
          state: "pending",
          delivery: "queued",
          requestId: "11111111-1111-4111-8111-111111111111",
          expiresAt: "2030-01-01T00:00:00Z",
        };
      },
      completeExomemEmailChange: async (action: string, token: string) => {
        mutations.push({ action, token });
        return { state: action === "confirm" ? "confirmed" : "cancelled" };
      },
      loadExomemEmailChange: async () => null,
    },
  })
);
beforeEach(() => {
  mutations = [];
  __setExomemSqlForTests(async () => ({
    rows: [
      {
        id: "session",
        user_id: "user",
        tenant_id: "tenant",
        csrf_digest: digestSecret(csrf),
        expires_at: "2030-01-01T00:00:00Z",
      },
    ],
  }));
});
afterEach(() => __setExomemSqlForTests(null));
after(() => mock.reset());
function request(body: unknown, overrides: Record<string, string> = {}): NextRequest {
  return new Request("https://example.test/api/exomem/account/email-change", {
    method: "POST",
    headers: {
      host: "example.test",
      origin: "https://example.test",
      "content-type": "application/json",
      cookie: `exomem_session=${sessionToken}; exomem_csrf=${csrf}`,
      "x-exomem-csrf": csrf,
      ...overrides,
    },
    body: JSON.stringify(body),
  }) as NextRequest;
}

describe("email change HTTP authority", () => {
  it("reports enqueue as queued rather than sent, without setting auth cookies", async () => {
    const { POST } = await import("../route");
    const response = await POST(request({ email: "new@example.test" }));
    assert.equal(response.status, 202);
    assert.equal((await response.json()).delivery, "queued");
    assert.equal(response.headers.getSetCookie().length, 0);
    assert.equal(mutations.length, 1);
  });
  it("rejects owner requests without matching session and CSRF authority", async () => {
    const { POST } = await import("../route");
    assert.equal((await POST(request({ email: "new@example.test" }, { cookie: "" }))).status, 401);
    assert.equal(
      (await POST(request({ email: "new@example.test" }, { "x-exomem-csrf": "wrong" }))).status,
      403
    );
    assert.equal(mutations.length, 0);
  });
  for (const action of ["confirm", "cancel"] as const) {
    it(`allows ${action} from another browser with its capability, without creating a session`, async () => {
      const { POST } = await import(`../${action}/route`);
      const response = await POST(
        request({ token: sessionToken }, { cookie: "", "x-exomem-csrf": "" })
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.getSetCookie().length, 0);
      assert.deepEqual(mutations, [{ action, token: sessionToken }]);
    });
  }
  it("rejects foreign origins, form posts and attempts to choose another account", async () => {
    const { POST } = await import("../confirm/route");
    assert.equal(
      (await POST(request({ token: sessionToken }, { origin: "https://foreign.test" }))).status,
      403
    );
    assert.equal(
      (await POST(request({ token: sessionToken }, { "content-type": "text/plain" }))).status,
      403
    );
    assert.equal((await POST(request({ token: sessionToken, tenantId: "another" }))).status, 400);
    assert.equal((await POST(request({ token: "a".repeat(300) }))).status, 413);
    assert.equal(mutations.length, 0);
  });
});
