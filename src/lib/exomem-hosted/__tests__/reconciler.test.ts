import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InMemoryLifecycleStore,
  LifecycleReconciler,
  expectedCellConfiguration,
} from "../reconciler";
import { FakeCellProvisioner, ProvisionerFailure } from "../provisioner";

const TENANT = "018f2d91-7c42-7000-8000-000000000051";

function harness(storeOverride?: InMemoryLifecycleStore) {
  const nowState = { value: new Date("2026-07-12T12:00:00.000Z") };
  const store = storeOverride ?? new InMemoryLifecycleStore({ now: () => nowState.value });
  const provisioner = new FakeCellProvisioner();
  const reconciler = new LifecycleReconciler({
    store,
    provisioner,
    config: expectedCellConfiguration({
      protocolVersion: "1",
      releaseVersion: "2026.07.12",
      workerPolicy: { workerCount: 0, semantic: false, media: false },
    }),
    now: () => nowState.value,
    randomBytes: (size) => Buffer.alloc(size, 0x51),
    envelopeKey: Buffer.alloc(32, 0x61),
  });
  return { store, provisioner, reconciler, nowState };
}

async function convergeProvision(reconciler: LifecycleReconciler, tenantId = TENANT, max = 12) {
  for (let index = 0; index < max; index += 1) {
    await reconciler.reconcileOne({ owner: `worker-${index}`, tenantId });
  }
}

describe("Exomem lifecycle reconciler", () => {
  it("converges duplicate initial provision to one candidate and one active binding", async () => {
    const { store, provisioner, reconciler } = harness();
    const first = await store.enqueue(TENANT, "provision", "initial-provision");
    const duplicate = await store.enqueue(TENANT, "provision", "initial-provision");
    assert.equal(duplicate.id, first.id);

    await convergeProvision(reconciler);

    const tenant = store.tenants.get(TENANT);
    assert.equal(tenant?.status, "active");
    assert.ok(tenant?.boundCellId);
    assert.equal([...store.cells.values()].filter((cell) => cell.tenantId === TENANT).length, 1);
    assert.equal(provisioner.resources.size, 1);
    assert.equal(store.operations.get(first.id)?.state, "succeeded");
  });

  it("allows only one concurrent reconciler to advance a leased checkpoint", async () => {
    const { store, reconciler } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");

    const results = await Promise.all([
      reconciler.reconcileOne({ owner: "worker-a", tenantId: TENANT }),
      reconciler.reconcileOne({ owner: "worker-b", tenantId: TENANT }),
    ]);

    assert.equal(results.filter((result) => result.kind === "advanced").length, 1);
    assert.equal(store.checkpointHistory.length, 1);
  });

  it("takes over a stale lease and reuses the exact checkpoint idempotency key", async () => {
    const { store, reconciler, nowState, provisioner } = harness();
    const operation = await store.enqueue(TENANT, "provision", "initial-provision");
    await store.claim({ owner: "crashed", leaseMs: 1_000, maxAttempts: 6, tenantId: TENANT });
    nowState.value = new Date(nowState.value.getTime() + 1_001);

    await reconciler.reconcileOne({ owner: "replacement", tenantId: TENANT });
    await convergeProvision(reconciler);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    const provisionCalls = provisioner.calls.filter((call) => call.action === "provision");
    assert.ok(provisionCalls.length >= 1);
    assert.equal(new Set(provisionCalls.map((call) => call.idempotencyKey)).size, 1);
  });

  it("adopts a provisioned resource after a lost acknowledgement", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await reconciler.reconcileOne({ owner: "worker-a", tenantId: TENANT });
    provisioner.loseNextAcknowledgement("provision");
    await reconciler.reconcileOne({ owner: "worker-a", tenantId: TENANT });

    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler);

    assert.equal(provisioner.resources.size, 1);
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  it("adopts an already-published binding when the checkpoint acknowledgement is lost", async () => {
    class LostBindingAcknowledgementStore extends InMemoryLifecycleStore {
      lost = false;

      override async advance(
        operationId: string,
        owner: string,
        expectedCheckpoint: string,
        nextCheckpoint: string
      ): Promise<boolean> {
        if (!this.lost && expectedCheckpoint === "readiness-proved" && nextCheckpoint === "bound") {
          const operation = this.operations.get(operationId);
          const candidate = operation?.cellId ? this.cells.get(operation.cellId) : null;
          assert.equal(candidate?.routingState, "bound");
          if (operation) operation.leaseExpiresAt = new Date(0);
          this.lost = true;
          return false;
        }
        return super.advance(operationId, owner, expectedCheckpoint, nextCheckpoint);
      }
    }

    const store = new LostBindingAcknowledgementStore();
    const { reconciler } = harness(store);
    const operation = await store.enqueue(TENANT, "provision", "lost-binding-ack");

    await convergeProvision(reconciler, TENANT, 16);

    assert.equal(store.lost, true);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  for (const mismatch of ["cellId", "protocolVersion", "releaseVersion"] as const) {
    it(`fails terminally and never binds on wrong readiness ${mismatch}`, async () => {
      const { store, reconciler, provisioner } = harness();
      const operation = await store.enqueue(TENANT, "provision", "initial-provision");
      await reconciler.reconcileOne({ owner: "candidate", tenantId: TENANT });
      await reconciler.reconcileOne({ owner: "provider", tenantId: TENANT });
      provisioner.readinessOverride = { [mismatch]: "wrong-value" };

      await reconciler.reconcileOne({ owner: "readiness", tenantId: TENANT });

      assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
      assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
      assert.equal(store.operations.get(operation.id)?.errorCode, "CELL_READINESS_MISMATCH");
    });
  }

  it("does not bind without service auth, mutation authority, admissions, or expected workers", async () => {
    for (const override of [
      { serviceAuthenticated: false },
      { mutationAuthority: false },
      { readAdmission: false },
      { writeAdmission: false },
      { workerPolicy: { workerCount: 1, semantic: true, media: false } },
    ]) {
      const { store, reconciler, provisioner } = harness();
      const operation = await store.enqueue(TENANT, "provision", "initial-provision");
      await reconciler.reconcileOne({ owner: "candidate", tenantId: TENANT });
      await reconciler.reconcileOne({ owner: "provider", tenantId: TENANT });
      provisioner.readinessOverride = override;
      await reconciler.reconcileOne({ owner: "readiness", tenantId: TENANT });
      assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
      assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
    }
  });

  it("backs off unavailable cells, bounds attempts, and never binds an alternate", async () => {
    const { store, reconciler, provisioner } = harness();
    const operation = await store.enqueue(TENANT, "provision", "initial-provision");
    provisioner.failure = new ProvisionerFailure({
      code: "PROVISIONER_UNAVAILABLE",
      retryable: true,
    });
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await store.makeRunnable(TENANT);
      await reconciler.reconcileOne({ owner: `worker-${attempt}`, tenantId: TENANT });
    }
    assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
    assert.equal(store.operations.get(operation.id)?.errorCode, "LIFECYCLE_MAX_ATTEMPTS");
    assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
    assert.equal(provisioner.resources.size, 0);
  });

  it("preserves the prior cell while a replacement candidate fails readiness", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const prior = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(prior);

    await store.enqueue(TENANT, "restore", "restore-1");
    provisioner.readinessOverride = { cellId: "wrong-cell" };
    await convergeProvision(reconciler);

    assert.equal(store.tenants.get(TENANT)?.boundCellId, prior);
    assert.equal(store.cells.get(prior ?? "")?.routingState, "bound");
  });

  it("applies suspension before the external call and resumes only after readiness", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    await store.enqueue(TENANT, "suspend", "suspend-1", cellId);
    await reconciler.reconcileOne({ owner: "local-suspend", tenantId: TENANT });
    assert.equal(store.tenants.get(TENANT)?.status, "suspended");
    assert.equal(provisioner.calls.at(-1)?.action, "health");
    await convergeProvision(reconciler);
    assert.equal(store.statusForTenant(TENANT).state, "suspended");

    await store.enqueue(TENANT, "resume", "resume-1", cellId);
    await reconciler.reconcileOne({ owner: "local-resume", tenantId: TENANT });
    assert.equal(store.tenants.get(TENANT)?.status, "suspended");
    await convergeProvision(reconciler);
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  it("rotates credentials through overlap-safe staged and finalized checkpoints", async () => {
    const { store, reconciler } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    const before = store.cells.get(cellId ?? "")?.credentialVersion;

    const operation = await store.enqueue(TENANT, "rotate_credential", "rotate-1", cellId);
    await convergeProvision(reconciler);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.cells.get(cellId ?? "")?.credentialVersion, (before ?? 0) + 1);
    assert.equal(store.cells.get(cellId ?? "")?.pendingCredentialEnvelope, null);
    assert.deepEqual(
      store.checkpointHistory
        .filter((entry) => entry.operationId === operation.id)
        .map((entry) => entry.checkpoint),
      ["rotation-prepared", "rotation-staged", "rotation-promoted", "rotation-finalized"]
    );
  });

  it("never exposes provider or credential sentinels in stored failure/status", async () => {
    const { store, reconciler, provisioner } = harness();
    const sentinel = "provider-credential-email-path-query-sensitive-sentinel";
    const operation = await store.enqueue(TENANT, "provision", "initial-provision");
    provisioner.failure = new ProvisionerFailure({
      code: "PROVISIONER_UNAVAILABLE",
      retryable: true,
      cause: new Error(sentinel),
    });
    await reconciler.reconcileOne({ owner: "worker", tenantId: TENANT });

    assert.equal(JSON.stringify(store.operations.get(operation.id)).includes(sentinel), false);
    assert.equal(JSON.stringify(store.statusForTenant(TENANT)).includes(sentinel), false);
  });
});
