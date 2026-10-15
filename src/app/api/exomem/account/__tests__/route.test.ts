import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { exomemErrors } from "@/lib/exomem-hosted/errors";

let sessionError: Error | null = null;

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => {
        if (sessionError) throw sessionError;
        return {
          id: "018f2d91-7c42-7000-8000-000000000091",
          userId: "018f2d91-7c42-7000-8000-000000000092",
          tenantId: "018f2d91-7c42-7000-8000-000000000093",
          csrfDigest: Buffer.alloc(32),
          expiresAt: "2026-07-26T00:00:00.000Z",
        };
      },
    },
  });
  mock.module("@/lib/exomem-hosted/account-view", {
    namedExports: {
      loadExomemAccountView: async () => ({ kind: "owner", supportReference: "EX-7Q4M" }),
    },
  });
  mock.module("@/lib/exomem-hosted/billing-account", {
    namedExports: {
      ownerBillingSummary: async () => ({
        source: "complimentary",
        state: "active",
        portalAvailable: false,
      }),
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  sessionError = null;
});

describe("GET /api/exomem/account", () => {
  it("does not return another session account's billing facts to the rendered checkout", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/account?tenantId=018f2d91-7c42-7000-8000-000000000094"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.error.code, "EXOMEM_ENTITLEMENT_DENIED");
    assert.equal(body.account, undefined);
    assert.equal(body.billing, undefined);
  });
  it("returns the owner's billing summary unchanged next to the account facts, privately", async () => {
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/account"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text), {
      success: true,
      billing: { source: "complimentary", state: "active", portalAvailable: false },
      account: { kind: "owner", supportReference: "EX-7Q4M" },
    });
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/i);
  });

  it("returns no account data without an Exomem product session", async () => {
    sessionError = exomemErrors.sessionInvalid();
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/account"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.doesNotMatch(text, /billing|complimentary|EX-7Q4M/i);
  });
});
