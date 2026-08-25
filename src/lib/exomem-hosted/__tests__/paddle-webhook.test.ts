import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  comparePaddleRevisions,
  dispatchVerifiedExomemPaddleEvent,
  mapPaddleSubscriptionState,
  type AtomicExomemPaddleEventStore,
  type ExomemPaddleEventApplication,
  type ExomemPaddleStoreResult,
} from "../paddle-webhook";
import { EXOMEM_ALPHA_BUNDLE, evaluateExomemEntitlement } from "../entitlements";

const USER_ID = "018f2d91-7c42-7000-8000-000000000061";
const TENANT_ID = "018f2d91-7c42-7000-8000-000000000062";

function env(overrides: Record<string, string | undefined> = {}) {
  return {
    PADDLE_ENVIRONMENT: "sandbox",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_example",
    EXOMEM_PADDLE_PRODUCT_ID: "pro_exomem",
    ...overrides,
  };
}

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_id: "evt_exomem_1",
    event_type: "subscription.created",
    occurred_at: "2026-07-12T10:00:00.000Z",
    environment: "sandbox",
    data: {
      id: "sub_provider_internal",
      transaction_id: "txn_provider_internal",
      customer_id: "ctm_provider_internal",
      status: "active",
      custom_data: {
        product_key: "exomem-hosted",
        user_id: USER_ID,
        tenant_id: TENANT_ID,
      },
      items: [{ price: { id: "pri_exomem", product_id: "pro_exomem" } }],
    },
    ...overrides,
  };
}

class MemoryAtomicStore implements AtomicExomemPaddleEventStore {
  readonly processed = new Set<string>();
  readonly audit: ExomemPaddleEventApplication[] = [];
  projection: ExomemPaddleEventApplication | null = null;
  failNext = false;
  calls = 0;

  async applyVerifiedEventAndMarkProcessedAtomically(
    application: ExomemPaddleEventApplication
  ): Promise<ExomemPaddleStoreResult> {
    this.calls += 1;
    if (this.processed.has(application.eventId)) {
      return { outcome: "duplicate" };
    }
    if (this.failNext) {
      this.failNext = false;
      throw new Error("RAW_PROVIDER_SENTINEL sub_secret ctm_secret");
    }

    // This clone-then-commit shape models the adapter contract: receipt,
    // projection and processed state become visible together or not at all.
    const nextAudit = [...this.audit, application];
    let outcome: ExomemPaddleStoreResult["outcome"] = "applied";
    let nextProjection = this.projection;
    if (application.sourceState) {
      if (
        nextProjection &&
        comparePaddleRevisions(application.revision, nextProjection.revision) < 0
      ) {
        outcome = "stale";
      } else {
        nextProjection = application;
      }
    } else {
      outcome = "ignored";
    }

    this.audit.splice(0, this.audit.length, ...nextAudit);
    this.projection = nextProjection;
    this.processed.add(application.eventId);
    return { outcome };
  }
}

describe("Exomem Paddle webhook dispatcher", () => {
  it("maps all supported Paddle subscription states explicitly", () => {
    assert.equal(mapPaddleSubscriptionState("active"), "active");
    assert.equal(mapPaddleSubscriptionState("trialing"), "trialing");
    assert.equal(mapPaddleSubscriptionState("past_due"), "past_due");
    assert.equal(mapPaddleSubscriptionState("paused"), "paused");
    assert.equal(mapPaddleSubscriptionState("canceled"), "cancelled");
    assert.equal(mapPaddleSubscriptionState("cancelled"), "cancelled");
    assert.equal(mapPaddleSubscriptionState("unknown"), null);
  });

  it("routes trusted product metadata and projects only trusted correlation", async () => {
    const store = new MemoryAtomicStore();
    const result = await dispatchVerifiedExomemPaddleEvent(event(), {
      env: env(),
      store,
    });

    assert.deepEqual(result, { kind: "handled", outcome: "applied" });
    assert.equal(store.audit.length, 1);
    assert.deepEqual(store.audit[0].correlation, {
      productKey: "exomem-hosted",
      userId: USER_ID,
      tenantId: TENANT_ID,
    });
    assert.equal(store.audit[0].providerReferences.customerId, "ctm_provider_internal");
    assert.equal(store.audit[0].providerReferences.subscriptionId, "sub_provider_internal");
    assert.equal(store.audit[0].providerReferences.transactionId, "txn_provider_internal");
    assert.equal(store.audit[0].sourceState, "active");
  });

  it("retains checkout transaction correlation when activation arrives first", async () => {
    const store = new MemoryAtomicStore();

    const result = await dispatchVerifiedExomemPaddleEvent(
      event({ event_type: "subscription.activated" }),
      { env: env(), store }
    );

    assert.deepEqual(result, { kind: "handled", outcome: "applied" });
    assert.equal(store.audit[0].providerReferences.transactionId, "txn_provider_internal");
  });

  it("routes by configured catalog membership when product_key is absent", async () => {
    const store = new MemoryAtomicStore();
    const candidate = event();
    const data = candidate.data as Record<string, unknown>;
    data.custom_data = {
      user_id: USER_ID,
      tenant_id: TENANT_ID,
    };

    const result = await dispatchVerifiedExomemPaddleEvent(candidate, {
      env: env(),
      store,
    });

    assert.equal(result.kind, "handled");
    assert.equal(store.calls, 1);
  });

  it("accepts an omitted payload environment after verified endpoint routing", async () => {
    const store = new MemoryAtomicStore();
    const candidate = event();
    delete candidate.environment;

    const result = await dispatchVerifiedExomemPaddleEvent(candidate, {
      env: env(),
      store,
    });

    assert.deepEqual(result, { kind: "handled", outcome: "applied" });
  });

  it("fails closed on conflicting product metadata or environment", async () => {
    const conflictStore = new MemoryAtomicStore();
    const conflict = event();
    const conflictData = conflict.data as {
      custom_data: Record<string, string>;
    };
    conflictData.custom_data.product_key = "endstate";

    const conflictResult = await dispatchVerifiedExomemPaddleEvent(conflict, {
      env: env(),
      store: conflictStore,
    });
    const mismatchResult = await dispatchVerifiedExomemPaddleEvent(
      event({ environment: "production" }),
      { env: env(), store: new MemoryAtomicStore() }
    );

    assert.deepEqual(conflictResult, {
      kind: "rejected",
      code: "EXOMEM_PADDLE_PRODUCT_CONFLICT",
      status: 400,
    });
    assert.deepEqual(mismatchResult, {
      kind: "rejected",
      code: "EXOMEM_PADDLE_ENVIRONMENT_MISMATCH",
      status: 400,
    });
    assert.equal(conflictStore.calls, 0);
  });

  it("rejects an Exomem key paired with a different configured catalog", async () => {
    const store = new MemoryAtomicStore();
    const conflict = event();
    const data = conflict.data as {
      items: Array<{ price: { id: string; product_id: string } }>;
    };
    data.items[0].price.product_id = "pro_other_product";

    const result = await dispatchVerifiedExomemPaddleEvent(conflict, {
      env: env(),
      store,
    });

    assert.deepEqual(result, {
      kind: "rejected",
      code: "EXOMEM_PADDLE_PRODUCT_CONFLICT",
      status: 400,
    });
    assert.equal(store.calls, 0);
  });

  it("does not route ordinary Endstate events or validate Exomem config for them", async () => {
    const result = await dispatchVerifiedExomemPaddleEvent(
      {
        event_id: "evt_endstate",
        event_type: "subscription.created",
        data: {
          custom_data: { user_id: "endstate-user" },
          items: [{ price: { id: "pri_endstate" } }],
        },
      },
      { env: {}, store: new MemoryAtomicStore() }
    );

    assert.deepEqual(result, { kind: "not_exomem" });
  });

  it("keeps a transiently failed receipt processable on retry", async () => {
    const store = new MemoryAtomicStore();
    store.failNext = true;

    const first = await dispatchVerifiedExomemPaddleEvent(event(), {
      env: env(),
      store,
    });
    assert.deepEqual(first, {
      kind: "rejected",
      code: "EXOMEM_PADDLE_TRANSIENT_FAILURE",
      status: 503,
    });
    assert.equal(store.processed.size, 0);
    assert.equal(store.audit.length, 0);

    const retry = await dispatchVerifiedExomemPaddleEvent(event(), {
      env: env(),
      store,
    });
    assert.deepEqual(retry, { kind: "handled", outcome: "applied" });
    assert.equal(store.processed.size, 1);
    assert.equal(store.audit.length, 1);
  });

  it("audits Exomem transaction events as ignored instead of falling into Endstate", async () => {
    const store = new MemoryAtomicStore();
    const result = await dispatchVerifiedExomemPaddleEvent(
      event({
        event_id: "evt_exomem_transaction",
        event_type: "transaction.completed",
        data: {
          ...(event().data as Record<string, unknown>),
          id: "txn_provider_internal",
          subscription_id: "sub_provider_internal",
        },
      }),
      { env: env(), store }
    );

    assert.deepEqual(result, { kind: "handled", outcome: "ignored" });
    assert.equal(store.audit.length, 1);
    assert.equal(store.audit[0].sourceState, null);
  });

  it("acknowledges duplicates without applying twice", async () => {
    const store = new MemoryAtomicStore();
    await dispatchVerifiedExomemPaddleEvent(event(), { env: env(), store });
    const duplicate = await dispatchVerifiedExomemPaddleEvent(event(), {
      env: env(),
      store,
    });

    assert.deepEqual(duplicate, { kind: "handled", outcome: "duplicate" });
    assert.equal(store.audit.length, 1);
  });

  it("retains out-of-order events without replacing a newer source state", async () => {
    const store = new MemoryAtomicStore();
    const newer = event({
      event_id: "evt_newer_paused",
      event_type: "subscription.paused",
      occurred_at: "2026-07-12T12:00:00.000Z",
      data: {
        ...(event().data as Record<string, unknown>),
        status: "paused",
      },
    });
    const older = event({
      event_id: "evt_older_active",
      event_type: "subscription.activated",
      occurred_at: "2026-07-12T11:00:00.000Z",
    });

    await dispatchVerifiedExomemPaddleEvent(newer, { env: env(), store });
    const result = await dispatchVerifiedExomemPaddleEvent(older, {
      env: env(),
      store,
    });

    assert.deepEqual(result, { kind: "handled", outcome: "stale" });
    assert.equal(store.audit.length, 2);
    assert.equal(store.projection?.sourceState, "paused");
  });

  it("never lets a newer provider event clear manual suspension", async () => {
    const store = new MemoryAtomicStore();
    await dispatchVerifiedExomemPaddleEvent(event(), { env: env(), store });

    const effective = evaluateExomemEntitlement({
      lifecycleState: "ready",
      sourceProjection: {
        source: "paddle",
        state: store.projection?.sourceState ?? "cancelled",
      },
      manuallySuspended: true,
      bundle: EXOMEM_ALPHA_BUNDLE,
    });
    assert.equal(effective.effectiveState, "suspended");
    assert.equal(effective.decisions.read.allowed, false);
  });

  it("requires authoritative user and tenant correlation for Exomem events", async () => {
    const store = new MemoryAtomicStore();
    const malformed = event();
    const data = malformed.data as Record<string, unknown>;
    data.custom_data = { product_key: "exomem-hosted" };

    const result = await dispatchVerifiedExomemPaddleEvent(malformed, {
      env: env(),
      store,
    });

    assert.deepEqual(result, {
      kind: "rejected",
      code: "EXOMEM_PADDLE_CORRELATION_INVALID",
      status: 400,
    });
    assert.equal(store.calls, 0);
  });

  it("rejects non-UUID correlation before the atomic PostgreSQL boundary", async () => {
    const store = new MemoryAtomicStore();
    const malformed = event();
    const data = malformed.data as { custom_data: Record<string, string> };
    data.custom_data.user_id = "not-a-database-id";

    assert.deepEqual(
      await dispatchVerifiedExomemPaddleEvent(malformed, {
        env: env(),
        store,
      }),
      {
        kind: "rejected",
        code: "EXOMEM_PADDLE_CORRELATION_INVALID",
        status: 400,
      }
    );
    assert.equal(store.calls, 0);
  });
});
