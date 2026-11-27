import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import type { NextRequest } from "next/server";

const OWNER = "018f2d91-7c42-7000-8000-000000000092";
const TENANT = "018f2d91-7c42-7000-8000-000000000093";

const calls: Array<{ call: string; principal: unknown; enabled?: boolean }> = [];
let saved: { enabled: boolean; invited: boolean } | null = { enabled: true, invited: false };

before(() => {
  mock.module("@/lib/exomem-hosted/sessions", {
    namedExports: {
      resolveExomemSession: async () => ({ userId: OWNER, tenantId: TENANT }),
      validateMutationRequest: () => undefined,
    },
  });
  mock.module("@/lib/exomem-hosted/whats-new-digest/setting", {
    namedExports: {
      setMonthlyUpdateEmail: async (principal: unknown, enabled: boolean) => {
        calls.push({ call: "set", principal, enabled });
        return saved;
      },
      dismissMonthlyUpdateInvitation: async (principal: unknown) => {
        calls.push({ call: "dismiss", principal });
        return saved;
      },
    },
  });
});
after(() => mock.reset());
beforeEach(() => {
  calls.length = 0;
  saved = { enabled: true, invited: false };
});

const put = async (body: unknown) => {
  const { PUT } = await import("../route");
  return PUT(
    new Request("https://substratesystems.io/api/exomem/account/monthly-update-email", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
};

describe("PUT /api/exomem/account/monthly-update-email", () => {
  it("turns the setting on or off for the session's own tenant and answers with the saved value, privately", async () => {
    const response = await put({ enabled: false });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.deepEqual(await response.json(), {
      success: true,
      monthlyUpdateEmail: { enabled: true, invited: false },
    });
    assert.deepEqual(calls, [
      { call: "set", principal: { userId: OWNER, tenantId: TENANT }, enabled: false },
    ]);
  });

  it("dismisses the invitation without touching the setting", async () => {
    assert.equal((await put({ dismissInvitation: true })).status, 200);
    assert.deepEqual(calls, [{ call: "dismiss", principal: { userId: OWNER, tenantId: TENANT } }]);
  });

  it("refuses a body that is not exactly one of the two changes", async () => {
    for (const body of [
      {},
      { enabled: "yes" },
      { enabled: true, dismissInvitation: true },
      { dismissInvitation: false },
      { enabled: true, tenantId: "018f2d91-7c42-7000-8000-000000000094" },
    ]) {
      assert.equal((await put(body)).status, 400, JSON.stringify(body));
    }
    assert.deepEqual(calls, []);
  });

  it("refuses an account that has no such setting, such as a reviewer's", async () => {
    saved = null;
    assert.equal((await put({ enabled: true })).status, 403);
  });
});
