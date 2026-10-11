import assert from "node:assert/strict";
import { after, afterEach, before, describe, it, mock } from "node:test";

// The confirm route over the real confirmDeletion and the real consume, with
// only the consume statement's result injected.

const SESSION = {
  id: "018f2d91-7c42-7000-8000-000000000081",
  userId: "018f2d91-7c42-7000-8000-000000000082",
  tenantId: "018f2d91-7c42-7000-8000-000000000083",
  csrfDigest: Buffer.alloc(32),
  expiresAt: "2026-09-24T00:00:00.000Z",
};

let consumeRow: Record<string, unknown> | null = null;
let calls: string[] = [];

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => SESSION,
      validateMutationRequest: () => undefined,
      clearSessionCookies: () => {
        calls.push("clear-cookies");
      },
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-lifecycle", {
    namedExports: {
      reconcileCloudCellDesiredState: async (tenantId: string) => {
        calls.push(`reconcile-cloud ${tenantId}`);
        return "deleted";
      },
    },
  });
  mock.module("@/lib/exomem-hosted/cloud-deletion-finish", {
    namedExports: {
      finishCloudAccountDeletion: async (tenantId: string) => {
        calls.push(`finish-cloud ${tenantId}`);
        return "finished";
      },
    },
  });
});

after(() => mock.reset());

afterEach(async () => {
  consumeRow = null;
  calls = [];
  const { __setExomemSqlForTests } = await import("@/lib/exomem-hosted/db");
  __setExomemSqlForTests(null);
});

async function injectConsumeResult(row: Record<string, unknown>): Promise<void> {
  consumeRow = row;
  const { __setExomemSqlForTests } = await import("@/lib/exomem-hosted/db");
  __setExomemSqlForTests(async (strings) => {
    assert.match(strings.join("?"), /exomem:consume-deletion-confirmation/);
    calls.push("consume");
    return { rows: consumeRow ? [consumeRow] : [], rowCount: consumeRow ? 1 : 0 };
  });
}

function confirmRequest(): import("next/server").NextRequest {
  return new Request("https://substratesystems.io/api/exomem/deletion/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "a".repeat(43) }),
  }) as unknown as import("next/server").NextRequest;
}

describe("POST /api/exomem/deletion/confirm", () => {
  it("answers a confirmation as pending after the Cloud reconcile and finish ran", async () => {
    await injectConsumeResult({ id: "018f2d91-7c42-7000-8000-000000000084" });
    const { POST } = await import("../route");
    const response = await POST(confirmRequest());
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { success: true, state: "deletion_pending" });
    assert.deepEqual(calls, [
      "consume",
      `reconcile-cloud ${SESSION.tenantId}`,
      `finish-cloud ${SESSION.tenantId}`,
      "clear-cookies",
    ]);
  });
});
