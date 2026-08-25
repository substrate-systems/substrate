import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { __setExomemSqlForTests } from "../db";
import {
  createSqlExomemPaddleEventStore,
  getDefaultSqlExomemPaddleEventStore,
  type ExomemPaddleSql,
} from "../paddle-event-store";
import type { ExomemPaddleEventApplication } from "../paddle-webhook";

const USER_ID = "018f2d91-7c42-7000-8000-000000000061";
const TENANT_ID = "018f2d91-7c42-7000-8000-000000000062";

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
      userId: USER_ID,
      tenantId: TENANT_ID,
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
  it("routes the default webhook store through the shared Exomem SQL executor", async () => {
    let calls = 0;
    __setExomemSqlForTests(async () => {
      calls += 1;
      return { rows: [{ outcome: "ignored" }] };
    });

    try {
      const result =
        await getDefaultSqlExomemPaddleEventStore().applyVerifiedEventAndMarkProcessedAtomically(
          application()
        );

      assert.deepEqual(result, { outcome: "ignored" });
      assert.equal(calls, 1);
    } finally {
      __setExomemSqlForTests(null);
    }
  });

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
    assert.match(sqlText, /WITH authoritative_target AS/i);
    assert.match(sqlText, /provider_transaction_ref/i);
    assert.match(sqlText, /provider_environment/i);
    assert.match(sqlText, /provider_environment IS NULL[\s\S]+webhook/i);
    assert.match(sqlText, /provenance_repaired/i);
    assert.match(sqlText, /owner_user_id/i);
    assert.match(sqlText, /INSERT INTO exomem_paddle_events/i);
    assert.match(sqlText, /UPDATE exomem_entitlements/i);
    assert.match(sqlText, /source_occurred_at/i);
    assert.match(sqlText, /source_revision/i);
    assert.match(sqlText, /manual_suspended_at IS NOT NULL/i);
    assert.match(
      sqlText,
      /reconciliation[\s\S]+tenant_status IN \('deletion_pending', 'deleted'\)[\s\S]+THEN 'ignored'/i
    );
    assert.match(sqlText, /disposition[\s\S]+ON CONFLICT \(paddle_event_id\) DO NOTHING/i);
    assert.match(sqlText, /applied_at/i);
    assert.match(sqlText, /projection_guard/i);
    assert.equal(
      values.includes("live"),
      true,
      "production config maps to the migration live environment value"
    );
  });

  it("releases the reserved initial provision inside the activation statement", async () => {
    let sqlText = "";
    const store = createSqlExomemPaddleEventStore(async (strings) => {
      sqlText = strings.join("?");
      return { rows: [{ outcome: "applied" }] };
    });

    await store.applyVerifiedEventAndMarkProcessedAtomically(
      application({
        eventType: "subscription.created",
        sourceState: "active",
        providerReferences: {
          customerId: "ctm_control_plane",
          subscriptionId: "sub_control_plane",
          transactionId: "txn_control_plane",
          productId: "pro_control_plane",
          priceId: "pri_control_plane",
        },
      })
    );

    assert.match(sqlText, /locked_allocation[\s\S]*FOR UPDATE/i);
    assert.match(sqlText, /INSERT INTO exomem_lifecycle_operations/i);
    assert.match(sqlText, /'provision'[\s\S]*'initial-provision'/i);
    assert.match(sqlText, /UPDATE exomem_capacity_allocations[\s\S]*operation_id/i);
    assert.match(sqlText, /provision_release_guard/i);
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
