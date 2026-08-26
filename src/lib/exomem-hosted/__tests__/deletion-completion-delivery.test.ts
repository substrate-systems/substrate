import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  drainDeletionCompletionDeliveries,
  type DeletionCompletionDeliveryDependencies,
} from "../deletion-completion-delivery";

const LEASE_OWNER = "11111111-1111-4111-8111-111111111111";

function dependencies(
  overrides: Partial<DeletionCompletionDeliveryDependencies> = {}
): DeletionCompletionDeliveryDependencies {
  let next = {
    deliveryId: "delivery-1",
    tenantId: "tenant-1",
    emailNormalized: "owner@example.com",
    attempts: 1,
  };
  return {
    newLeaseOwner: () => LEASE_OWNER,
    claim: async () => {
      const claimed = next;
      next = null as never;
      return claimed;
    },
    markSent: async () => true,
    release: async () => "retry",
    sendEmail: async () => ({ success: true, messageId: "message-1" }),
    ...overrides,
  };
}

describe("durable Exomem deletion-completion delivery", () => {
  it("emails the current owner and marks the unique delivery sent", async () => {
    let email: Record<string, unknown> | undefined;
    let marked: Record<string, unknown> | undefined;
    const result = await drainDeletionCompletionDeliveries(
      { maxMessages: 1 },
      dependencies({
        sendEmail: async (input) => {
          email = input;
          return { success: true, messageId: "message-1" };
        },
        markSent: async (input) => {
          marked = input;
          return true;
        },
      })
    );

    assert.deepEqual(result, {
      claimed: 1,
      sent: 1,
      retryScheduled: 0,
      failed: 0,
      lost: 0,
    });
    assert.equal(email?.to, "owner@example.com");
    assert.equal(email?.senderEmail, "exomem@substratesystems.io");
    assert.equal(email?.subject, "Your Exomem has been deleted");
    assert.deepEqual(marked, { deliveryId: "delivery-1", leaseOwner: LEASE_OWNER });
  });

  it("releases provider failure for bounded retry without exposing provider detail", async () => {
    let released: Record<string, unknown> | undefined;
    const result = await drainDeletionCompletionDeliveries(
      { maxMessages: 1 },
      dependencies({
        sendEmail: async () => ({ success: false, error: "recipient-private-sentinel" }),
        release: async (input) => {
          released = input;
          return "retry";
        },
      })
    );

    assert.equal(result.retryScheduled, 1);
    assert.deepEqual(released, {
      deliveryId: "delivery-1",
      leaseOwner: LEASE_OWNER,
      errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
    });
  });
});
