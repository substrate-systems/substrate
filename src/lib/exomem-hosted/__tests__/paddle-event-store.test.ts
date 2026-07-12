import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSqlExomemPaddleEventStore, type ExomemPaddleSql } from "../paddle-event-store";
import type { ExomemPaddleEventApplication } from "../paddle-webhook";

function application(
  overrides: Partial<ExomemPaddleEventApplication> = {}
): ExomemPaddleEventApplication {
  return {
    eventId: "evt_atomic",
    eventType: "subscription.updated",
    environment: "production",
    origin: "webhook",
    revision: {
      occurredAt: "2026-07-12T14:00:00.000Z",
      eventId: "evt_atomic",
    },
    correlation: {
      productKey: "exomem-hosted",
      userId: "user-internal",
      tenantId: "tenant-internal",
    },
    sourceState: "past_due",
    capabilities: ["capture", "recall", "export"],
    resourceLimits: {
      storageBytes: 5 * 1024 * 1024 * 1024,
      uploadBytes: 100 * 1024 * 1024,
      workerCount: 0,
    },
    providerReferences: {
      customerId: "ctm_control_plane",
      subscriptionId: "sub_control_plane",
      transactionId: null,
      productId: "pro_control_plane",
      priceId: "pri_control_plane",
    },
    ...overrides,
  };
}

describe("SQL Exomem Paddle event store", () => {
  it("uses one atomic statement for receipt, monotonic projection and applied marker", async () => {
    let calls = 0;
    let sqlText = "";
    let values: unknown[] = [];
    const sql: ExomemPaddleSql = async (strings, ...nextValues) => {
      calls += 1;
      sqlText = strings.join("?");
      values = nextValues;
      return { rows: [{ outcome: "applied" }] };
    };
    const store = createSqlExomemPaddleEventStore(sql);

    const result = await store.applyVerifiedEventAndMarkProcessedAtomically(application());

    assert.deepEqual(result, { outcome: "applied" });
    assert.equal(calls, 1, "the adapter must expose no split begin/apply window");
    assert.match(sqlText, /WITH claimed AS/i);
    assert.match(sqlText, /INSERT INTO exomem_paddle_events/i);
    assert.match(sqlText, /UPDATE exomem_entitlements/i);
    assert.match(sqlText, /source_occurred_at/i);
    assert.match(sqlText, /source_revision/i);
    assert.match(sqlText, /manual_suspended_at IS NOT NULL/i);
    assert.match(sqlText, /SET disposition/i);
    assert.match(sqlText, /applied_at/i);
    assert.equal(
      values.includes("live"),
      true,
      "production config maps to the migration live environment value"
    );
  });

  it("preserves every store outcome without inventing a successful apply", async () => {
    for (const outcome of ["duplicate", "stale", "ignored"] as const) {
      const store = createSqlExomemPaddleEventStore(async () => ({
        rows: [{ outcome }],
      }));
      assert.deepEqual(await store.applyVerifiedEventAndMarkProcessedAtomically(application()), {
        outcome,
      });
    }
  });

  it("fails retryably when the atomic statement commits no disposition", async () => {
    const store = createSqlExomemPaddleEventStore(async () => ({ rows: [] }));
    await assert.rejects(
      store.applyVerifiedEventAndMarkProcessedAtomically(application()),
      /EXOMEM_PADDLE_ATOMIC_APPLY_FAILED/
    );
  });
});
