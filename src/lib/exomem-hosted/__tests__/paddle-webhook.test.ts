import assert from "node:assert/strict";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import {
  comparePaddleRevisions,
  dispatchVerifiedExomemPaddleEvent,
  mapPaddleSubscriptionState,
  type AtomicExomemPaddleEventStore,
  type CloudPaddleHook,
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

  // Item 2 / tasks 3.4 & 3.7: the post-commit Cloud hook (activateCloudCellOnCheckoutAtomic +
  // reconcileCloudCellDesiredState) runs exactly once per authoritative event.
  // The store's own outcome -- "applied" exactly once per genuine change,
  // "duplicate" on redelivery, "stale" on an event that arrives out of order
  // behind a newer one -- is the only idempotency logic this hook relies on,
  // so this proves it end to end through the real dispatcher rather than
  // through the hook function in isolation. Before dispatchVerifiedExomemPaddleEvent
  // calls the injected hook at all, hookCalls stays empty and this fails at
  // the very first assertion.
  it("calls the Cloud post-commit hook exactly once per authoritative event, never on duplicate or stale redelivery", async () => {
    const store = new MemoryAtomicStore();
    const hookCalls: ExomemPaddleEventApplication[] = [];
    const cloudHook: CloudPaddleHook = async (application) => {
      hookCalls.push(application);
    };

    const first = await dispatchVerifiedExomemPaddleEvent(event(), {
      env: env(),
      store,
      cloudHook,
    });
    assert.deepEqual(first, { kind: "handled", outcome: "applied" });
    assert.equal(hookCalls.length, 1);
    assert.equal(hookCalls[0]!.correlation.tenantId, TENANT_ID);

    // Same event redelivered by Paddle: the store answers "duplicate" and the
    // hook must not run a second time.
    const replay = await dispatchVerifiedExomemPaddleEvent(event(), {
      env: env(),
      store,
      cloudHook,
    });
    assert.deepEqual(replay, { kind: "handled", outcome: "duplicate" });
    assert.equal(hookCalls.length, 1);

    // An older event for the same tenant arriving after a newer one: "stale",
    // no additional hook call -- the store's own revision ordering is what
    // this hook leans on for idempotency, not any logic of its own.
    const stale = await dispatchVerifiedExomemPaddleEvent(
      event({ event_id: "evt_exomem_0_earlier", occurred_at: "2026-07-12T09:00:00.000Z" }),
      { env: env(), store, cloudHook }
    );
    assert.deepEqual(stale, { kind: "handled", outcome: "stale" });
    assert.equal(hookCalls.length, 1);

    // A genuinely new, later, distinct authoritative change: exactly one more
    // hook call.
    const next = await dispatchVerifiedExomemPaddleEvent(
      event({
        event_id: "evt_exomem_2_later",
        event_type: "subscription.paused",
        occurred_at: "2026-07-12T11:00:00.000Z",
      }),
      { env: env(), store, cloudHook }
    );
    assert.deepEqual(next, { kind: "handled", outcome: "applied" });
    assert.equal(hookCalls.length, 2);
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

// Item 2 / tasks 3.4 & 3.7: the real (non-injected) default Cloud hook --
// flag gating and reconcile-driven active/trialing "checkout completed"
// handling -- rather than the dispatcher's exactly-once invocation contract
// proved above.
//
// Security review finding 13: there is no separate "activate on checkout"
// call any more. reconcileCloudCellDesiredState alone maps an active/trialing
// entitlement to `running`, so activateCloudCellOnCheckoutAtomic was deleted
// and this suite no longer mocks or asserts on it.
describe("Exomem Paddle webhook default Cloud post-commit hook", () => {
  let reconcileCalls: string[] = [];
  let cancellationNoticeCalls: Array<{ tenantId: string; sourceOccurredAt: Date }> = [];

  before(() => {
    mock.module("@/lib/exomem-hosted/cloud-lifecycle", {
      namedExports: {
        reconcileCloudCellDesiredState: async (tenantId: string) => {
          reconcileCalls.push(tenantId);
          return "running";
        },
      },
    });
    // Item 5 / task 3.7: a distinct fake from the one above -- if the hook
    // never called this at all, cancellationNoticeCalls would stay empty
    // even on a "cancelled" event, and the flag-on test below would fail on
    // that assertion.
    mock.module("@/lib/exomem-hosted/cloud-cancellation-notice", {
      namedExports: {
        sendCloudCancellationNoticeOnce: async (tenantId: string, sourceOccurredAt: Date) => {
          cancellationNoticeCalls.push({ tenantId, sourceOccurredAt });
          return true;
        },
      },
    });
  });

  after(() => mock.reset());

  beforeEach(() => {
    reconcileCalls = [];
    cancellationNoticeCalls = [];
    delete process.env.EXOMEM_CLOUD_ENABLED;
  });

  afterEach(() => {
    delete process.env.EXOMEM_CLOUD_ENABLED;
  });

  it("flag off: never imports or calls either Cloud function", async () => {
    const store = new MemoryAtomicStore();
    const result = await dispatchVerifiedExomemPaddleEvent(event(), { env: env(), store });
    assert.deepEqual(result, { kind: "handled", outcome: "applied" });
    assert.equal(reconcileCalls.length, 0);
    assert.equal(cancellationNoticeCalls.length, 0);
  });

  it("flag on: an active/trialing checkout event reconciles the cell; other entitlement events reconcile too", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const store = new MemoryAtomicStore();

    const activation = await dispatchVerifiedExomemPaddleEvent(event(), { env: env(), store });
    assert.deepEqual(activation, { kind: "handled", outcome: "applied" });
    assert.deepEqual(reconcileCalls, [TENANT_ID]);

    const paused = await dispatchVerifiedExomemPaddleEvent(
      event({
        event_id: "evt_exomem_paused",
        event_type: "subscription.paused",
        occurred_at: "2026-07-12T12:00:00.000Z",
      }),
      { env: env(), store }
    );
    assert.deepEqual(paused, { kind: "handled", outcome: "applied" });
    // Every authoritative event reconciles, whether it's a fresh checkout or
    // a later transition -- reconcileCloudCellDesiredState is the only thing
    // that ever moves the cell towards running.
    assert.deepEqual(reconcileCalls, [TENANT_ID, TENANT_ID]);
    // Not a cancellation either.
    assert.equal(cancellationNoticeCalls.length, 0);
  });

  it("flag on: a cancellation event sends the cancellation notice keyed on the event's own occurredAt; other entitlement events do not", async () => {
    process.env.EXOMEM_CLOUD_ENABLED = "true";
    const store = new MemoryAtomicStore();

    const cancelled = await dispatchVerifiedExomemPaddleEvent(
      event({
        event_id: "evt_exomem_cancelled",
        event_type: "subscription.canceled",
        occurred_at: "2026-07-12T12:00:00.000Z",
      }),
      { env: env(), store }
    );
    assert.deepEqual(cancelled, { kind: "handled", outcome: "applied" });
    assert.equal(cancellationNoticeCalls.length, 1);
    assert.equal(cancellationNoticeCalls[0]!.tenantId, TENANT_ID);
    assert.equal(
      cancellationNoticeCalls[0]!.sourceOccurredAt.toISOString(),
      "2026-07-12T12:00:00.000Z"
    );
    assert.deepEqual(reconcileCalls, [TENANT_ID]);

    const paused = await dispatchVerifiedExomemPaddleEvent(
      event({
        event_id: "evt_exomem_paused_2",
        event_type: "subscription.paused",
        occurred_at: "2026-07-12T13:00:00.000Z",
      }),
      { env: env(), store }
    );
    assert.deepEqual(paused, { kind: "handled", outcome: "applied" });
    // Unchanged: still exactly the one cancellation call above.
    assert.equal(cancellationNoticeCalls.length, 1);
  });

  it("flag off: a cancellation event never calls the cancellation notice", async () => {
    const store = new MemoryAtomicStore();
    const cancelled = await dispatchVerifiedExomemPaddleEvent(
      event({ event_type: "subscription.canceled" }),
      { env: env(), store }
    );
    assert.deepEqual(cancelled, { kind: "handled", outcome: "applied" });
    assert.equal(cancellationNoticeCalls.length, 0);
  });
});
