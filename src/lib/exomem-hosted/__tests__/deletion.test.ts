import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { confirmDeletion, requestDeletionConfirmation } from "../deletion";
import { ExomemHostedError } from "../errors";
import { tokenDigest } from "../security";

const SESSION = {
  userId: "018f2d91-7c42-7000-8000-000000000091",
  tenantId: "018f2d91-7c42-7000-8000-000000000092",
};

describe("Exomem product-scoped deletion confirmation", () => {
  it("emails one fragment token and persists only its digest", async () => {
    let storedDigestHex = "";
    let email = "";
    const result = await requestDeletionConfirmation(SESSION, {
      now: () => new Date("2026-07-12T12:00:00.000Z"),
      randomBytes: (size) => Buffer.alloc(size, 0x61),
      publicBaseUrl: "https://example.test",
      takeRateLimit: async () => true,
      createToken: async (input) => {
        storedDigestHex = input.tokenDigest.toString("hex");
        return { tokenId: "token-id", emailNormalized: "owner@example.test" };
      },
      markDelivered: async () => undefined,
      sendEmail: async (input) => {
        email = `${input.htmlContent}\n${input.textContent}`;
        return { success: true };
      },
    });

    assert.equal(result.delivery, "sent");
    const match = email.match(/https:\/\/example\.test\/exomem\/delete#([A-Za-z0-9_-]+)/);
    assert.ok(match);
    assert.equal(storedDigestHex, tokenDigest(match[1])?.toString("hex"));
    assert.equal(email.includes("shared Substrate identity"), true);
  });

  it("rejects an unsafe public origin before sending a deletion link", async () => {
    let sends = 0;
    await assert.rejects(
      requestDeletionConfirmation(SESSION, {
        now: () => new Date("2026-07-12T12:00:00.000Z"),
        randomBytes: (size) => Buffer.alloc(size, 0x61),
        publicBaseUrl: "https://user:password@example.test",
        takeRateLimit: async () => true,
        createToken: async () => ({ tokenId: "token-id", emailNormalized: "owner@example.test" }),
        markDelivered: async () => undefined,
        sendEmail: async () => {
          sends += 1;
          return { success: true };
        },
      }),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "PUBLIC_BASE_URL_INVALID"
    );
    assert.equal(sends, 0);
  });

  it("consumes a token only for the current product owner and returns pending", async () => {
    let consumed: Buffer | null = null;
    const result = await confirmDeletion("a".repeat(43), SESSION, {
      consume: async (input) => {
        consumed = input.tokenDigest;
        assert.equal(input.userId, SESSION.userId);
        assert.equal(input.tenantId, SESSION.tenantId);
        return {
          operationId: "018f2d91-7c42-7000-8000-000000000093",
          requestId: "018f2d91-7c42-7000-8000-000000000094",
        };
      },
      reconcile: async () => ({ attempted: true, code: "RECONCILE_STEP_ACCEPTED" }),
    });

    assert.ok(consumed);
    assert.equal(result.state, "deletion_pending");
  });

  // Cloud design D4 table: account deletion reaches the tenant's Cloud cell
  // row at once; the periodic Cloud sweep is only the backstop.
  it("reconciles the Cloud cell on a confirmed deletion only while Cloud is enabled", async () => {
    const consume = async () => ({
      operationId: "018f2d91-7c42-7000-8000-000000000093",
      requestId: "018f2d91-7c42-7000-8000-000000000094",
    });
    const reconcile = async () => ({ attempted: true, code: "RECONCILE_STEP_ACCEPTED" }) as const;
    const reconciledCloud: string[] = [];
    const reconcileCloud = async (tenantId: string) => {
      reconciledCloud.push(tenantId);
    };

    const finishCloud = async () => undefined;

    delete process.env.EXOMEM_CLOUD_ENABLED;
    await confirmDeletion("c".repeat(43), SESSION, {
      consume,
      reconcile,
      reconcileCloud,
      finishCloud,
    });
    assert.deepEqual(reconciledCloud, []);

    process.env.EXOMEM_CLOUD_ENABLED = "1";
    try {
      await confirmDeletion("d".repeat(43), SESSION, {
        consume,
        reconcile,
        reconcileCloud,
        finishCloud,
      });
      // A failing Cloud reconcile never fails the confirmation itself.
      const result = await confirmDeletion("e".repeat(43), SESSION, {
        consume,
        reconcile,
        reconcileCloud: async () => {
          throw new Error("transient");
        },
        finishCloud,
      });
      assert.equal(result.state, "deletion_pending");
    } finally {
      delete process.env.EXOMEM_CLOUD_ENABLED;
    }
    assert.deepEqual(reconciledCloud, [SESSION.tenantId]);
  });

  // Cloud design D4 "Cloud deletion finish": billing cancellation and the
  // scrub follow the Cloud reconcile at once; the periodic sweep retries.
  it("runs the Cloud deletion finish after the Cloud reconcile, only while Cloud is enabled", async () => {
    const consume = async () => ({ operationId: null, requestId: null });
    const reconcile = async () => ({ attempted: false, code: "RECONCILE_IDLE" }) as const;
    const calls: string[] = [];
    const reconcileCloud = async (tenantId: string) => {
      calls.push(`reconcile ${tenantId}`);
    };
    const finishCloud = async (tenantId: string) => {
      calls.push(`finish ${tenantId}`);
    };

    delete process.env.EXOMEM_CLOUD_ENABLED;
    await confirmDeletion("f".repeat(43), SESSION, {
      consume,
      reconcile,
      reconcileCloud,
      finishCloud,
    });
    assert.deepEqual(calls, []);

    process.env.EXOMEM_CLOUD_ENABLED = "1";
    try {
      const result = await confirmDeletion("g".repeat(43), SESSION, {
        consume,
        reconcile,
        reconcileCloud,
        finishCloud,
      });
      assert.deepEqual(result, { state: "deletion_pending" });
      // A failing finish never fails the confirmation itself.
      const failed = await confirmDeletion("h".repeat(43), SESSION, {
        consume,
        reconcile,
        reconcileCloud,
        finishCloud: async () => {
          throw new Error("transient");
        },
      });
      assert.deepEqual(failed, { state: "deletion_pending" });
    } finally {
      delete process.env.EXOMEM_CLOUD_ENABLED;
    }
    assert.deepEqual(calls, [
      `reconcile ${SESSION.tenantId}`,
      `finish ${SESSION.tenantId}`,
      `reconcile ${SESSION.tenantId}`,
    ]);
  });

  it("reports a v1 operation id only when the confirmation queued one", async () => {
    const reconcile = async () => ({ attempted: false, code: "RECONCILE_IDLE" }) as const;
    const v1 = await confirmDeletion("i".repeat(43), SESSION, {
      consume: async () => ({
        operationId: "018f2d91-7c42-7000-8000-000000000093",
        requestId: "018f2d91-7c42-7000-8000-000000000094",
      }),
      reconcile,
    });
    assert.deepEqual(v1, {
      operationId: "018f2d91-7c42-7000-8000-000000000093",
      requestId: "018f2d91-7c42-7000-8000-000000000094",
      state: "deletion_pending",
    });
    const cloud = await confirmDeletion("j".repeat(43), SESSION, {
      consume: async () => ({ operationId: null, requestId: null }),
      reconcile,
    });
    assert.deepEqual(cloud, { state: "deletion_pending" });
  });

  it("maps replay and wrong-owner confirmation to one safe failure", async () => {
    await assert.rejects(
      confirmDeletion("b".repeat(43), SESSION, {
        consume: async () => null,
        reconcile: async () => ({ attempted: false, code: "RECONCILE_IDLE" }),
      }),
      (error) => error instanceof ExomemHostedError && error.code === "ACCESS_TOKEN_INVALID"
    );
  });
});
