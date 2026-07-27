import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import { exomemErrors } from "@/lib/exomem-hosted/errors";

let sessionError: Error | null = null;
let installActions: unknown[] = [];

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
  mock.module("@/lib/exomem-hosted/billing-account", {
    namedExports: {
      ownerBillingSummary: async () => ({
        source: "complimentary",
        state: "active",
        checkoutAvailable: false,
        portalAvailable: false,
      }),
    },
  });
  mock.module("@/lib/exomem-hosted/account-install-actions", {
    namedExports: {
      loadOwnerInstallActions: async () => installActions,
    },
  });
});

after(() => mock.reset());

beforeEach(() => {
  sessionError = null;
  installActions = [];
});

describe("GET /api/exomem/account", () => {
  it("returns a live native install action without internal artifact fields", async () => {
    installActions = [
      {
        platform: "claude",
        version: "0.34.0",
        installUrl: "https://claude.ai/plugins/exomem-hosted",
      },
    ];
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/account"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.deepEqual(JSON.parse(text).installActions, installActions);
    assert.doesNotMatch(text, /tenant|mcp|bearer|token|secret|evidence/i);
    assert.match(response.headers.get("cache-control") ?? "", /private, no-store/i);
  });

  it("does not return install actions without an Exomem product session", async () => {
    sessionError = exomemErrors.sessionInvalid();
    const { GET } = await import("../route");
    const response = await GET(
      new Request(
        "https://substratesystems.io/api/exomem/account"
      ) as unknown as import("next/server").NextRequest
    );
    assert.equal(response.status, 401);
    const text = await response.text();
    assert.doesNotMatch(text, /installActions|claude|openai/i);
  });
});
