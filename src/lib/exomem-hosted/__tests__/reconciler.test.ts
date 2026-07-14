import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InMemoryLifecycleStore,
  LifecycleReconciler,
  expectedCellConfiguration,
} from "../reconciler";
import { FakeCellProvisioner, ProvisionerFailure, ProvisionerPending } from "../provisioner";
import { digestSecret, encryptSecret } from "../security";

const TENANT = "018f2d91-7c42-7000-8000-000000000051";

function billingProof(tenantId: string) {
  return {
    tenantId,
    userId: "018f2d91-7c42-7000-8000-000000000050",
    source: "complimentary" as const,
    sourceState: "complimentary_active",
    sourceRevision: null,
    providerEnvironment: null,
    customerRef: null,
    subscriptionRef: null,
    transactionRef: null,
  };
}

function harness(
  storeOverride?: InMemoryLifecycleStore,
  terminateBilling: (tenantId: string) => Promise<boolean> = async () => true,
  provisionerOverride?: FakeCellProvisioner
) {
  const nowState = { value: new Date("2026-07-12T12:00:00.000Z") };
  const store = storeOverride ?? new InMemoryLifecycleStore({ now: () => nowState.value });
  const provisioner = provisionerOverride ?? new FakeCellProvisioner({ now: () => nowState.value });
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
    terminateBilling: async (tenantId) =>
      (await terminateBilling(tenantId)) ? billingProof(tenantId) : null,
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

  it("drains a fenced in-flight provision before tenant-wide deletion", async () => {
    class DeferredProvisioner extends FakeCellProvisioner {
      readonly started: Promise<void>;
      readonly release: Promise<void>;
      markStarted: () => void;
      releaseProvision: () => void;

      constructor() {
        super();
        this.markStarted = () => undefined;
        this.releaseProvision = () => undefined;
        this.started = new Promise<void>((resolve) => {
          this.markStarted = resolve;
        });
        this.release = new Promise<void>((resolve) => {
          this.releaseProvision = resolve;
        });
      }

      override async provision(request: Parameters<FakeCellProvisioner["provision"]>[0]) {
        this.markStarted();
        await this.release;
        return super.provision(request);
      }
    }

    const provisioner = new DeferredProvisioner();
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    const provision = await store.enqueue(TENANT, "provision", "deferred-provision");
    await reconciler.reconcileOne({ owner: "candidate", tenantId: TENANT });
    const providerCall = reconciler.reconcileOne({ owner: "provider", tenantId: TENANT });
    await provisioner.started;

    const deletion = await store.enqueue(TENANT, "delete", "delete-during-provision");
    assert.equal(
      (await reconciler.reconcileOne({ owner: "delete-too-early", tenantId: TENANT })).kind,
      "idle"
    );
    provisioner.releaseProvision();
    await providerCall;
    assert.equal(store.operations.get(provision.id)?.state, "running");

    nowState.value = new Date(nowState.value.getTime() + 31_000);
    await convergeProvision(reconciler, TENANT, 20);
    assert.equal(store.operations.get(deletion.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "deleted");
    assert.equal(provisioner.resources.size, 0);
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

  it("waits through more than six provider-pending polls without consuming attempts", async () => {
    class PendingProvisioner extends FakeCellProvisioner {
      remaining = 8;

      override async provision(request: Parameters<FakeCellProvisioner["provision"]>[0]) {
        if (this.remaining > 0) {
          this.remaining -= 1;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          });
        }
        return super.provision(request);
      }
    }

    const provisioner = new PendingProvisioner();
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    const operation = await store.enqueue(TENANT, "provision", "long-provider-provision");
    await reconciler.reconcileOne({ owner: "candidate", tenantId: TENANT });

    for (let poll = 0; poll < 8; poll += 1) {
      const result = await reconciler.reconcileOne({ owner: `poll-${poll}`, tenantId: TENANT });
      assert.equal(result.kind, "retry_scheduled");
      assert.equal(store.operations.get(operation.id)?.state, "waiting");
      assert.equal(store.operations.get(operation.id)?.attempts, 0);
      assert.equal(store.operations.get(operation.id)?.errorCode, null);
      nowState.value = new Date(nowState.value.getTime() + 2_001);
    }

    await convergeProvision(reconciler, TENANT, 8);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
  });

  it("waits through more than six restore polls without consuming attempts", async () => {
    class PendingRestoreProvisioner extends FakeCellProvisioner {
      remaining = 8;

      override async restore(request: Parameters<FakeCellProvisioner["restore"]>[0]) {
        if (this.remaining > 0) {
          this.remaining -= 1;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          });
        }
        return super.restore(request);
      }
    }

    const provisioner = new PendingRestoreProvisioner();
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const priorCellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(priorCellId);
    const restoreRef = "stored-export-long-restore";
    const operation = await store.enqueue(TENANT, "restore", "long-provider-restore", null, {
      inputReferenceEnvelope: encryptSecret(restoreRef, {
        key: Buffer.alloc(32, 0x61),
        randomBytes: (size) => Buffer.alloc(size, 0x41),
      }),
      inputReferenceDigest: digestSecret(restoreRef),
      restoreBinding: {
        exportId: "018f2d91-7c42-7000-8000-000000000052",
        sourceCellId: priorCellId,
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        archiveSize: 1024,
      },
    });
    await reconciler.reconcileOne({ owner: "candidate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "provider", tenantId: TENANT });

    for (let poll = 0; poll < 8; poll += 1) {
      const result = await reconciler.reconcileOne({ owner: `restore-${poll}`, tenantId: TENANT });
      assert.equal(result.kind, "retry_scheduled");
      assert.equal(store.operations.get(operation.id)?.checkpoint, "provider-converged");
      assert.equal(store.operations.get(operation.id)?.state, "waiting");
      assert.equal(store.operations.get(operation.id)?.attempts, 0);
      nowState.value = new Date(nowState.value.getTime() + 2_001);
    }

    await convergeProvision(reconciler, TENANT, 12);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.notEqual(store.tenants.get(TENANT)?.boundCellId, priorCellId);
  });

  it("keeps a seven-day deletion pending beyond six polls without consuming attempts", async () => {
    class PendingDestroyProvisioner extends FakeCellProvisioner {
      remaining = 8;

      override async destroy(request: Parameters<FakeCellProvisioner["destroy"]>[0]) {
        if (this.remaining > 0) {
          this.remaining -= 1;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 300,
          });
        }
        return super.destroy(request);
      }
    }

    const provisioner = new PendingDestroyProvisioner();
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "delete", "long-provider-delete", cellId);
    for (let step = 0; step < 4; step += 1) {
      await reconciler.reconcileOne({ owner: `delete-setup-${step}`, tenantId: TENANT });
    }
    assert.equal(store.operations.get(operation.id)?.checkpoint, "sealed");

    for (let poll = 0; poll < 8; poll += 1) {
      const result = await reconciler.reconcileOne({ owner: `destroy-${poll}`, tenantId: TENANT });
      assert.equal(result.kind, "retry_scheduled");
      assert.equal(store.operations.get(operation.id)?.checkpoint, "sealed");
      assert.equal(store.operations.get(operation.id)?.state, "waiting");
      assert.equal(store.operations.get(operation.id)?.attempts, 0);
      nowState.value = new Date(nowState.value.getTime() + 24 * 60 * 60 * 1_000 + 1);
    }

    await convergeProvision(reconciler, TENANT, 4);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "deleted");
    assert.equal(provisioner.resources.has(cellId), false);
  });

  it("waits on a pending tenant destroy when deletion has no bound cell", async () => {
    class PendingTenantDestroyProvisioner extends FakeCellProvisioner {
      override destroy(
        request: Parameters<FakeCellProvisioner["destroy"]>[0]
      ): ReturnType<FakeCellProvisioner["destroy"]> {
        return Promise.reject(
          new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 300,
          })
        );
      }
    }

    const provisioner = new PendingTenantDestroyProvisioner();
    const { store, reconciler } = harness(undefined, async () => true, provisioner);
    const operation = await store.enqueue(TENANT, "delete", "no-cell-delete");
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "no-cell-quiesce", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "billing", tenantId: TENANT });

    const result = await reconciler.reconcileOne({ owner: "destroy", tenantId: TENANT });
    assert.equal(result.kind, "retry_scheduled");
    assert.equal(store.operations.get(operation.id)?.checkpoint, "billing-quiesced");
    assert.equal(store.operations.get(operation.id)?.state, "waiting");
    assert.equal(store.operations.get(operation.id)?.attempts, 0);
    assert.equal(store.operations.get(operation.id)?.errorCode, null);
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
      await convergeProvision(reconciler, TENANT, 4);

      assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
      assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
      assert.equal(store.operations.get(operation.id)?.errorCode, "CELL_READINESS_MISMATCH");
      assert.equal(provisioner.resources.size, 0);
      const failedCell = store.cells.get(store.operations.get(operation.id)?.cellId ?? "");
      assert.equal(failedCell?.providerRef, null);
      assert.equal(failedCell?.credentialEnvelope, null);
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
      await convergeProvision(reconciler, TENANT, 4);
      assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
      assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
      assert.equal(provisioner.resources.size, 0);
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
    assert.equal(store.operations.get(operation.id)?.checkpoint, "candidate-cleanup");
    assert.equal(store.operations.get(operation.id)?.state, "failed_retryable");
    provisioner.failure = null;
    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler, TENANT, 4);
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

    const restoreRef = "stored-export-restore-1";
    await store.enqueue(TENANT, "restore", "restore-1", null, {
      inputReferenceEnvelope: encryptSecret(restoreRef, {
        key: Buffer.alloc(32, 0x61),
        randomBytes: (size) => Buffer.alloc(size, 0x41),
      }),
      inputReferenceDigest: digestSecret(restoreRef),
      restoreBinding: {
        exportId: "018f2d91-7c42-7000-8000-000000000052",
        sourceCellId: prior,
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        archiveSize: 1024,
      },
    });
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
      [
        "rotation-prepared",
        "rotation-staged",
        "rotation-verified",
        "rotation-promoted",
        "rotation-finalized",
        "rotation-confirmed",
      ]
    );
  });

  it("records only a verified encrypted export and restores the prior running state", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "owner-export-1", cellId);
    await convergeProvision(reconciler, TENANT, 16);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    const exported = store.exports.get(operation.id);
    assert.ok(exported);
    assert.match(exported.archiveSha256, /^[0-9a-f]{64}$/);
    assert.match(exported.manifestSha256, /^[0-9a-f]{64}$/);
    assert.equal(exported.archiveSize, 1024);
    assert.equal(JSON.stringify(exported).includes(`export-${operation.id}`), false);
    assert.equal(store.statusForTenant(TENANT).state, "ready");
    assert.deepEqual(
      provisioner.calls
        .filter((call) => call.idempotencyKey.startsWith(operation.id))
        .map((call) => call.action),
      ["quiesce", "export", "release-export", "resume", "health"]
    );
  });

  it("retries a lost cell-release acknowledgement without exporting again", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "release-ack-loss", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "export", tenantId: TENANT });
    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-stored");
    assert.equal(provisioner.exportArtifacts.size, 1);
    provisioner.loseNextAcknowledgement("release-export");
    await reconciler.reconcileOne({ owner: "lost-release-ack", tenantId: TENANT });

    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-stored");
    assert.equal(provisioner.exportArtifacts.size, 0);
    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler, TENANT, 12);

    const calls = provisioner.calls.filter((call) => call.idempotencyKey.startsWith(operation.id));
    assert.equal(calls.filter((call) => call.action === "export").length, 1);
    assert.equal(calls.filter((call) => call.action === "release-export").length, 2);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
  });

  it("replays a lost export response with the same durable expiry and no second object", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "export-ack-loss", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    provisioner.loseNextAcknowledgement("export");
    const lost = await reconciler.reconcileOne({ owner: "lost-export-ack", tenantId: TENANT });
    assert.equal(lost.kind, "retry_scheduled");
    assert.equal(provisioner.exportArtifacts.size, 1);

    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler, TENANT, 12);

    const calls = provisioner.calls.filter((call) => call.idempotencyKey.startsWith(operation.id));
    assert.equal(calls.filter((call) => call.action === "export").length, 2);
    assert.equal(store.exports.has(operation.id), true);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
  });

  it("leaves an already suspended tenant quiesced after export", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    await store.enqueue(TENANT, "suspend", "suspend-before-export", cellId);
    await convergeProvision(reconciler);

    const operation = await store.enqueue(TENANT, "export", "suspended-export", cellId);
    assert.equal(operation.resumeAfterOperation, false);
    await convergeProvision(reconciler, TENANT, 16);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "suspended");
    assert.equal(
      provisioner.calls.some(
        (call) => call.action === "resume" && call.idempotencyKey.startsWith(operation.id)
      ),
      false
    );
  });

  it("marks deletion complete only after quiesce, seal, and full destruction proof", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "delete", "confirmed-delete", cellId);
    await convergeProvision(reconciler, TENANT, 16);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "deleted");
    assert.equal(store.tenants.get(TENANT)?.boundCellId, null);
    assert.equal(provisioner.resources.has(cellId), false);
    assert.deepEqual(
      provisioner.calls
        .filter((call) => call.idempotencyKey.startsWith(operation.id))
        .map((call) => call.action),
      ["quiesce", "seal", "destroy"]
    );
  });

  it("quiesces a pre-deploy billing-terminated deletion before sealing it", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "delete", "pre-deploy-delete", cellId);
    const stored = store.operations.get(operation.id);
    assert.ok(stored);
    stored.checkpoint = "billing-terminated";

    const quiesced = await reconciler.reconcileOne({ owner: "upgrade-quiesce", tenantId: TENANT });
    assert.deepEqual(quiesced, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "billing-quiesced",
    });
    assert.equal(provisioner.resources.get(cellId)?.state, "quiesced");
    assert.equal(
      provisioner.calls.some(
        (call) => call.action === "seal" && call.idempotencyKey.startsWith(operation.id)
      ),
      false
    );

    await reconciler.reconcileOne({ owner: "upgrade-seal", tenantId: TENANT });
    assert.equal(store.operations.get(operation.id)?.checkpoint, "sealed");
  });

  it("quiesces direct-transfer admission before waiting for billing termination", async () => {
    const { store, reconciler, provisioner } = harness(undefined, async () => false);
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "delete", "paid-delete", cellId);

    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const result = await reconciler.reconcileOne({ owner: "billing", tenantId: TENANT });

    assert.equal(result.kind, "retry_scheduled");
    assert.equal(store.operations.get(operation.id)?.errorCode, "BILLING_TERMINATION_UNAVAILABLE");
    assert.equal(store.statusForTenant(TENANT).state, "deletion_pending");
    assert.equal(provisioner.resources.get(cellId)?.state, "quiesced");
    assert.equal(
      provisioner.calls.some(
        (call) => call.action === "quiesce" && call.idempotencyKey.startsWith(operation.id)
      ),
      true
    );
    assert.equal(
      provisioner.calls.some(
        (call) =>
          ["seal", "destroy"].includes(call.action) && call.idempotencyKey.startsWith(operation.id)
      ),
      false
    );
  });

  it("finishes destruction and secret scrubbing after an earlier deletion retry", async () => {
    let billingAttempts = 0;
    const { store, reconciler, provisioner } = harness(
      undefined,
      async () => ++billingAttempts > 1
    );
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "delete", "retrying-delete", cellId);

    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "billing-first", tenantId: TENANT });
    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler, TENANT, 20);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "deleted");
    assert.equal(provisioner.resources.has(cellId), false);
    assert.equal(store.cells.get(cellId)?.credentialEnvelope, null);
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

  it("runs the two-tenant alpha lifecycle drill without widening either blast radius", async () => {
    const alphaTenant = "018f2d91-7c42-7000-8000-000000000061";
    const bravoTenant = "018f2d91-7c42-7000-8000-000000000062";
    const now = new Date("2026-07-12T16:00:00.000Z");
    const store = new InMemoryLifecycleStore({ now: () => now });
    const provisioner = new FakeCellProvisioner({ now: () => now });
    let entropy = 1;
    const reconciler = new LifecycleReconciler({
      store,
      provisioner,
      config: expectedCellConfiguration({
        protocolVersion: "1",
        releaseVersion: "0.22.0",
        workerPolicy: { workerCount: 0, semantic: false, media: false },
      }),
      now: () => now,
      randomBytes: (size) => Buffer.alloc(size, entropy++),
      envelopeKey: Buffer.alloc(32, 0x71),
      terminateBilling: async (tenantId) => billingProof(tenantId),
    });

    // The same public retry key remains tenant-scoped and provisions two
    // distinct cells, credentials, endpoints, and provider resources.
    const alphaProvision = await store.enqueue(alphaTenant, "provision", "same-public-retry-key");
    const bravoProvision = await store.enqueue(bravoTenant, "provision", "same-public-retry-key");
    await convergeProvision(reconciler, alphaTenant);
    await convergeProvision(reconciler, bravoTenant);
    const alphaCell = store.tenants.get(alphaTenant)?.boundCellId;
    const bravoCell = store.tenants.get(bravoTenant)?.boundCellId;
    assert.ok(alphaCell);
    assert.ok(bravoCell);
    assert.notEqual(alphaProvision.id, bravoProvision.id);
    assert.notEqual(alphaCell, bravoCell);
    assert.equal(store.statusForTenant(alphaTenant).state, "ready");
    assert.equal(store.statusForTenant(bravoTenant).state, "ready");
    assert.notDeepEqual(
      store.cells.get(alphaCell)?.credentialDigest,
      store.cells.get(bravoCell)?.credentialDigest
    );

    await store.enqueue(alphaTenant, "suspend", "alpha-suspend", alphaCell);
    await convergeProvision(reconciler, alphaTenant);
    assert.equal(store.statusForTenant(alphaTenant).state, "suspended");
    assert.equal(store.statusForTenant(bravoTenant).state, "ready");
    assert.equal(provisioner.resources.get(bravoCell)?.state, "running");

    await store.enqueue(alphaTenant, "resume", "alpha-resume", alphaCell);
    await convergeProvision(reconciler, alphaTenant);
    const exportOperation = await store.enqueue(alphaTenant, "export", "alpha-export", alphaCell);
    await convergeProvision(reconciler, alphaTenant, 24);
    const exported = store.exports.get(exportOperation.id);
    assert.ok(exported);
    const exportReference = exported.storageReferenceEnvelope;
    assert.ok(exportReference);
    assert.equal(exported.tenantId, alphaTenant);
    assert.equal(store.statusForTenant(bravoTenant).state, "ready");

    const restoreOperation = await store.enqueue(alphaTenant, "restore", "alpha-restore", null, {
      inputReferenceEnvelope: exportReference,
      inputReferenceDigest: exported.storageReferenceDigest,
      restoreBinding: {
        exportId: exported.id,
        sourceCellId: exported.cellId,
        archiveSha256: exported.archiveSha256,
        manifestSha256: exported.manifestSha256,
        archiveSize: exported.archiveSize,
      },
    });
    await convergeProvision(reconciler, alphaTenant, 16);
    const replacementAlpha = store.tenants.get(alphaTenant)?.boundCellId;
    assert.ok(replacementAlpha);
    assert.notEqual(replacementAlpha, alphaCell);
    assert.equal(store.operations.get(restoreOperation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(alphaTenant).state, "ready");
    assert.equal(store.tenants.get(bravoTenant)?.boundCellId, bravoCell);

    const credentialBefore = store.cells.get(replacementAlpha)?.credentialVersion;
    await store.enqueue(alphaTenant, "rotate_credential", "alpha-rotate", replacementAlpha);
    await convergeProvision(reconciler, alphaTenant);
    assert.equal(store.cells.get(replacementAlpha)?.credentialVersion, (credentialBefore ?? 0) + 1);
    assert.equal(store.statusForTenant(bravoTenant).state, "ready");

    await store.enqueue(alphaTenant, "delete", "alpha-delete", replacementAlpha);
    await convergeProvision(reconciler, alphaTenant, 16);
    assert.equal(store.statusForTenant(alphaTenant).state, "deleted");
    assert.equal(provisioner.resources.has(replacementAlpha), false);
    assert.equal(store.statusForTenant(bravoTenant).state, "ready");
    assert.equal(store.tenants.get(bravoTenant)?.boundCellId, bravoCell);
    assert.equal(provisioner.resources.get(bravoCell)?.state, "running");
  });
});
