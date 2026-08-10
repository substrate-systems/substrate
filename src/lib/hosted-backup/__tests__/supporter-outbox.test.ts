import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __setHostedBackupSqlForTests,
  findPendingPaddleCancellations,
  findPendingSupporterEmails,
  getPaddleCancellationAttentionCount,
  getSupporterEmailAttentionCount,
  markPaddleCancellationAttempt,
  markSupporterEmailFailed,
  recordLegacySupporterContribution,
} from "../db";

const calls: string[] = [];

afterEach(() => {
  calls.length = 0;
  __setHostedBackupSqlForTests(null);
});

function install(rows: Array<Record<string, unknown>> = []) {
  __setHostedBackupSqlForTests(async (strings) => {
    calls.push(strings.join("?"));
    return { rows, rowCount: 1 };
  });
}

describe("supporter and cancellation durable queues", () => {
  it("selects unsent supporter obligations rather than re-sending delivered mail", async () => {
    install([
      {
        id: "o-1",
        kind: "supporter_thank_you",
        paddle_transaction_id: "txn-1",
        customer_email: "a@example.com",
        tier: "patron",
      },
    ]);
    const rows = await findPendingSupporterEmails(20);
    assert.equal(rows[0]?.kind, "supporter_thank_you");
    assert.match(calls[0], /sent_at IS NULL/);
  });

  it("records a failed delivery for retry without marking it sent", async () => {
    install();
    await markSupporterEmailFailed("o-1", "Brevo timeout");
    assert.match(calls[0], /attempts = attempts \+ 1/);
    assert.match(calls[0], /next_attempt_at/);
    assert.match(calls[0], /attention_required_at/);
    assert.doesNotMatch(calls[0], /sent_at = now\(\)/);
  });

  it("keeps failed supporter mail retryable and exposes it for operator attention", async () => {
    install([{ attention_count: 3 }]);
    await findPendingSupporterEmails(20);
    assert.doesNotMatch(calls[0], /attempts < 10/);
    assert.match(calls[0], /next_attempt_at <= now\(\)/);
    calls.length = 0;
    assert.equal(await getSupporterEmailAttentionCount(), 3);
    assert.match(calls[0], /attention_required_at IS NOT NULL/);
    assert.match(calls[0], /sent_at IS NULL/);
  });

  it("retries only cancellation tombstones that have not completed", async () => {
    install([{ id: "t-1", paddle_subscription_id: "sub-1" }]);
    await findPendingPaddleCancellations(20);
    assert.match(calls[0], /cancelled_at IS NULL/);
    assert.match(calls[0], /next_attempt_at <= now\(\)/);
    calls.length = 0;
    await markPaddleCancellationAttempt("t-1", false, "Paddle unavailable");
    assert.match(calls[0], /attempts = attempts \+ 1/);
    assert.match(calls[0], /cancelled_at = CASE WHEN/);
    assert.match(calls[0], /next_attempt_at = CASE\s+WHEN/);
    assert.match(calls[0], /attention_required_at/);
  });

  it("reports unresolved cancellation tombstones for operator attention", async () => {
    install([{ attention_count: 2 }]);
    assert.equal(await getPaddleCancellationAttentionCount(), 2);
    assert.match(calls[0], /attention_required_at IS NOT NULL/);
    assert.match(calls[0], /cancelled_at IS NULL/);
  });

  it("imports the existing Patron once without re-queuing historical email", async () => {
    install([{ inserted: true }]);
    assert.equal(
      await recordLegacySupporterContribution({
        transactionId: "txn-first-supporter",
        eventId: "evt-first-supporter",
        occurredAt: new Date("2026-08-01T12:00:00Z"),
        email: null,
      }),
      true
    );
    assert.match(calls[0], /supporter_contributions/);
    assert.match(calls[0], /sent_at/);
    assert.match(calls[0], /ON CONFLICT DO NOTHING/);
  });
});
