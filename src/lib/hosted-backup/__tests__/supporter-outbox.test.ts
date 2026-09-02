import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __setHostedBackupSqlForTests,
  findPendingPaddleCancellations,
  getPaddleCancellationAttentionCount,
  markPaddleCancellationAttempt,
  recordLegacySupporterContribution,
} from "../db";
import * as db from "../db";

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
  it("no longer exposes a supporter mail outbox drain", () => {
    // The Paddle supporter purchase path is retired: nothing enqueues mail, so
    // the drain is gone. The tables and the historical rows are untouched.
    for (const retired of [
      "recordSupporterContribution",
      "findPendingSupporterEmails",
      "markSupporterEmailDelivered",
      "markSupporterEmailFailed",
      "getSupporterEmailAttentionCount",
    ]) {
      assert.equal(retired in db, false, `${retired} must be retired with the supporter checkout`);
    }
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
