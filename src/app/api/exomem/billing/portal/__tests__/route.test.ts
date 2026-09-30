import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

let reviewerCredentialKind: string | null = null;
let portalCalls = 0;
before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({
        id: "session",
        userId: "owner",
        tenantId: "tenant",
        csrfDigest: Buffer.alloc(32),
        expiresAt: "2026-10-01T00:00:00Z",
        reviewerCredentialKind,
      }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/billing-account", {
    namedExports: {
      startOwnerPortal: async () => {
        portalCalls += 1;
        return { portalUrl: "https://portal.example.test" };
      },
    },
  });
});
after(() => mock.reset());

describe("Exomem customer portal session confinement", () => {
  it("denies Cloud reviewers before creating a portal", async () => {
    reviewerCredentialKind = "cloud_provider_review";
    portalCalls = 0;
    const { NextRequest } = await import("next/server");
    const { POST } = await import("../route");
    const response = await POST(
      new NextRequest("https://substratesystems.io/api/exomem/billing/portal", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      })
    );
    assert.equal(response.status, 403);
    assert.equal(portalCalls, 0);
  });
  for (const kind of [null, "provider_review", "internal_canary"]) {
    it(`preserves ${kind ?? "ordinary"} portal behavior`, async () => {
      reviewerCredentialKind = kind;
      portalCalls = 0;
      const { NextRequest } = await import("next/server");
      const { POST } = await import("../route");
      const response = await POST(
        new NextRequest("https://substratesystems.io/api/exomem/billing/portal", {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json" },
        })
      );
      assert.equal(response.status, 200);
      assert.equal(portalCalls, 1);
    });
  }
});
