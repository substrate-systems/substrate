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
        return true;
      },
      reconcileCloud: async () => undefined,
      finishCloud: async () => undefined,
    });

    assert.ok(consumed);
    assert.deepEqual(result, { state: "deletion_pending" });
  });

  // Cloud design D4 "Cloud deletion finish": the Cloud cell reconcile, then
  // billing cancellation and the scrub, follow the confirmation at once; the
  // periodic sweep is only the backstop and retries.
  it("reconciles the Cloud cell and then finishes the Cloud deletion", async () => {
    const calls: string[] = [];
    const result = await confirmDeletion("g".repeat(43), SESSION, {
      consume: async () => true,
      reconcileCloud: async (tenantId) => {
        calls.push(`reconcile ${tenantId}`);
      },
      finishCloud: async (tenantId) => {
        calls.push(`finish ${tenantId}`);
      },
    });
    assert.deepEqual(result, { state: "deletion_pending" });
    assert.deepEqual(calls, [`reconcile ${SESSION.tenantId}`, `finish ${SESSION.tenantId}`]);
  });

  it("keeps a confirmed deletion pending when the Cloud reconcile or finish fails", async () => {
    const failing = async () => {
      throw new Error("transient");
    };
    const reconcileFailed = await confirmDeletion("h".repeat(43), SESSION, {
      consume: async () => true,
      reconcileCloud: failing,
      finishCloud: async () => undefined,
    });
    const finishFailed = await confirmDeletion("i".repeat(43), SESSION, {
      consume: async () => true,
      reconcileCloud: async () => undefined,
      finishCloud: failing,
    });
    assert.deepEqual(reconcileFailed, { state: "deletion_pending" });
    assert.deepEqual(finishFailed, { state: "deletion_pending" });
  });

  it("maps replay and wrong-owner confirmation to one safe failure", async () => {
    await assert.rejects(
      confirmDeletion("b".repeat(43), SESSION, {
        consume: async () => false,
        reconcileCloud: async () => undefined,
        finishCloud: async () => undefined,
      }),
      (error) => error instanceof ExomemHostedError && error.code === "ACCESS_TOKEN_INVALID"
    );
  });
});
