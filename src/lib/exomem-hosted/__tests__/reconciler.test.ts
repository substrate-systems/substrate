import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  InMemoryLifecycleStore,
  LifecycleReconciler,
  expectedCellConfiguration,
} from "../reconciler";
import {
  FakeCellProvisioner,
  ProvisionerFailure,
  ProvisionerPending,
  type ProvisionMode,
} from "../provisioner";
import { digestSecret, encryptSecret } from "../security";

const TENANT = "018f2d91-7c42-7000-8000-000000000051";

class ProvisionModeRecordingProvisioner extends FakeCellProvisioner {
  readonly provisionModes: ProvisionMode[] = [];

  override async provision(request: Parameters<FakeCellProvisioner["provision"]>[0]) {
    this.provisionModes.push(request.provisionMode);
    return super.provision(request);
  }
}

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
  provisionerOverride?: FakeCellProvisioner,
  exportTtlMs = 24 * 60 * 60 * 1000
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
      exportTtlMs,
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

  it("distinguishes serving cells from restore candidates when provisioning", async () => {
    const provisioner = new ProvisionModeRecordingProvisioner();
    const { store, reconciler } = harness(undefined, async () => true, provisioner);
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    assert.equal(provisioner.provisionModes[0], "serve");

    const prior = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(prior);
    const restoreRef = "stored-export-mode-contract";
    await store.enqueue(TENANT, "restore", "restore-mode-contract", null, {
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
    await reconciler.reconcileOne({ owner: "restore-mode", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "restore-mode", tenantId: TENANT });

    assert.equal(provisioner.provisionModes.at(-1), "restore-candidate");
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
    const operation = await store.enqueue(TENANT, "provision", "initial-provision");
    await reconciler.reconcileOne({ owner: "worker-a", tenantId: TENANT });
    provisioner.loseNextAcknowledgement("provision");
    await reconciler.reconcileOne({ owner: "worker-a", tenantId: TENANT });

    assert.equal(store.capacityAllocations.get(operation.id)?.state, "uncertain");
    assert.equal(store.capacityClaims.size, 1);

    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler);

    assert.equal(provisioner.resources.size, 1);
    assert.equal(store.statusForTenant(TENANT).state, "ready");
    assert.equal(store.capacityAllocations.get(operation.id)?.state, "occupied");
  });

  it("waits for resume capacity before contacting the provider and retains storage on suspension", async () => {
    const { store, reconciler, provisioner, nowState } = harness();
    const initial = await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    await store.enqueue(TENANT, "suspend", "capacity-suspend", cellId);
    await convergeProvision(reconciler);
    assert.equal(store.capacityAllocations.get(initial.id)?.state, "retained_storage");

    store.runtimeCapacitySlots = 0;
    const resume = await store.enqueue(TENANT, "resume", "capacity-resume", cellId);
    await reconciler.reconcileOne({ owner: "resume-gate", tenantId: TENANT });
    const blocked = await reconciler.reconcileOne({ owner: "resume-capacity", tenantId: TENANT });
    assert.deepEqual(blocked, {
      kind: "retry_scheduled",
      operationId: resume.id,
      code: "CAPACITY_UNAVAILABLE",
    });
    assert.equal(
      provisioner.calls.some(
        (call) => call.action === "resume" && call.idempotencyKey.startsWith(resume.id)
      ),
      false
    );
    assert.equal(store.statusForTenant(TENANT).code, "CAPACITY_UNAVAILABLE");

    store.runtimeCapacitySlots = 1;
    nowState.value = new Date(nowState.value.getTime() + 2_001);
    await convergeProvision(reconciler);
    assert.equal(store.capacityAllocations.get(initial.id)?.state, "occupied");
  });

  it("admits an allocation-less provision only for an explicitly marked legacy tenant", async () => {
    const { store, reconciler, provisioner } = harness();
    const operation = await store.enqueue(TENANT, "provision", "legacy-unmetered");
    store.legacyUnmeteredTenants.add(TENANT);
    store.capacityAllocations.delete(operation.id);

    await convergeProvision(reconciler);

    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(provisioner.resources.size, 1);
    assert.equal(store.capacityClaims.size, 0);
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

  for (const mismatch of ["cellId", "protocolVersion", "releaseVersion", "code"] as const) {
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

  it("keeps the persisted export expiry when configuration changes before replay", async () => {
    const { store, provisioner, reconciler, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "expiry-config-change", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    provisioner.loseNextAcknowledgement("export");
    await reconciler.reconcileOne({ owner: "lost-export-ack", tenantId: TENANT });
    const persistedExpiry = store.operations.get(operation.id)?.exportExpiresAt;
    assert.ok(persistedExpiry);

    const changed = harness(store, async () => true, provisioner, 2 * 60 * 60 * 1000).reconciler;
    await store.makeRunnable(TENANT);
    await convergeProvision(changed, TENANT, 12);

    const calls = provisioner.calls.filter(
      (call) => call.action === "export" && call.idempotencyKey.startsWith(operation.id)
    );
    assert.equal(calls.length, 2);
    assert.equal(
      store.operations.get(operation.id)?.exportExpiresAt?.toISOString(),
      persistedExpiry.toISOString()
    );
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(nowState.value.toISOString(), "2026-07-12T12:00:00.000Z");
  });

  it("recovers a pre-upgrade export with its legacy idempotency identity", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "legacy-quiesced-request", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const stored = store.operations.get(operation.id);
    assert.ok(stored);
    stored.checkpoint = "export-requested";
    stored.exportExpiresAt = null;
    stored.exportRequestStarted = false;
    provisioner.loseNextAcknowledgement("export");

    await reconciler.reconcileOne({ owner: "legacy-lost-ack", tenantId: TENANT });
    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler, TENANT, 12);

    const calls = provisioner.calls.filter(
      (call) => call.action === "export" && call.idempotencyKey.startsWith(operation.id)
    );
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.idempotencyKey, `${operation.id}:export-requested`);
    assert.equal(calls[1]?.idempotencyKey, calls[0]?.idempotencyKey);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
  });

  it("advances an already-recorded legacy export without calling export again", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "legacy-recorded-export", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "recorded", tenantId: TENANT });
    const stored = store.operations.get(operation.id);
    assert.ok(stored?.exportReleaseEnvelope);
    stored.checkpoint = "export-requested";
    stored.state = "waiting";
    stored.nextAttemptAt = new Date(0);
    stored.exportExpiresAt = null;
    stored.exportRequestStarted = false;
    const exportCallsBeforeRecovery = provisioner.calls.filter(
      (call) => call.action === "export" && call.idempotencyKey.startsWith(operation.id)
    ).length;

    await convergeProvision(reconciler, TENANT, 12);

    assert.equal(
      provisioner.calls.filter(
        (call) => call.action === "export" && call.idempotencyKey.startsWith(operation.id)
      ).length,
      exportCallsBeforeRecovery
    );
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
  });

  it("replays an accepted pending export after expiry and releases the recovered artifact", async () => {
    const { store, reconciler, provisioner, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "pending-across-expiry", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    let pending = true;
    provisioner.export = async (request) => {
      const result = await createExport(request);
      if (pending) {
        pending = false;
        throw new ProvisionerPending({
          operationId: request.context.operationId,
          checkpoint: request.context.checkpoint,
          retryAfterSeconds: 2,
        });
      }
      return result;
    };

    const accepted = await reconciler.reconcileOne({ owner: "accepted", tenantId: TENANT });
    assert.equal(accepted.kind, "retry_scheduled");
    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-requested");
    const requestedExpiry = store.operations.get(operation.id)?.exportExpiresAt;
    assert.ok(requestedExpiry);
    nowState.value = new Date(requestedExpiry.getTime() + 1);
    await store.makeRunnable(TENANT);

    const recovered = await reconciler.reconcileOne({ owner: "expired-replay", tenantId: TENANT });
    assert.deepEqual(recovered, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "export-expired-released",
    });
    assert.equal(provisioner.exportArtifacts.size, 0);
    const exportCalls = provisioner.calls.filter((call) => call.action === "export");
    assert.equal(exportCalls.length, 2);
    assert.equal(exportCalls[0]?.idempotencyKey, `${operation.id}:export-requested`);
    assert.equal(exportCalls[1]?.idempotencyKey, exportCalls[0]?.idempotencyKey);

    await convergeProvision(reconciler, TENANT, 6);
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  it("resumes without a provider call when a new export has already expired", async () => {
    const { store, reconciler, provisioner, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "expired-before-request", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const requestedExpiry = store.operations.get(operation.id)?.exportExpiresAt;
    assert.ok(requestedExpiry);
    nowState.value = new Date(requestedExpiry.getTime() + 1);

    const rejected = await reconciler.reconcileOne({ owner: "expired-new", tenantId: TENANT });
    assert.deepEqual(rejected, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "export-failure-resume",
    });
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(provisioner.calls.filter((call) => call.action === "export").length, 0);

    await convergeProvision(reconciler, TENANT, 4);
    assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  it("keeps an already-suspended cell quiesced when export expires before contact", async () => {
    const { store, reconciler, provisioner, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    await store.enqueue(TENANT, "suspend", "suspend-before-pre-expired-export", cellId);
    await convergeProvision(reconciler);

    const operation = await store.enqueue(TENANT, "export", "suspended-pre-expired", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const stored = store.operations.get(operation.id);
    assert.ok(stored?.exportExpiresAt);
    nowState.value = new Date(stored.exportExpiresAt.getTime() + 1);

    const result = await reconciler.reconcileOne({ owner: "expired-new", tenantId: TENANT });

    assert.deepEqual(result, {
      kind: "terminal",
      operationId: operation.id,
      code: "EXPORT_EXPIRED",
    });
    assert.equal(store.cells.get(cellId)?.lifecycleState, "quiesced");
    assert.equal(store.statusForTenant(TENANT).state, "suspended");
    assert.equal(
      provisioner.calls.filter(
        (call) => call.action === "export" && call.idempotencyKey.startsWith(operation.id)
      ).length,
      0
    );
  });

  it("restores after a definitive expired request rejection instead of retrying forever", async () => {
    const { store, reconciler, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "expired-provider-reject", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const stored = store.operations.get(operation.id);
    assert.ok(stored?.exportExpiresAt);
    stored.exportRequestStarted = true;
    nowState.value = new Date(stored.exportExpiresAt.getTime() + 1);

    const rejected = await reconciler.reconcileOne({ owner: "provider-reject", tenantId: TENANT });
    assert.deepEqual(rejected, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "export-failure-resume",
    });
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");

    await convergeProvision(reconciler, TENANT, 8);
    assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  it("keeps recovering an ambiguous nonretryable export rejection", async () => {
    const { store, reconciler, provisioner } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "ambiguous-provider-reject", cellId);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    provisioner.failure = new ProvisionerFailure({
      code: "PROVISIONER_REJECTED",
      retryable: false,
    });

    const rejected = await reconciler.reconcileOne({ owner: "ambiguous", tenantId: TENANT });
    assert.deepEqual(rejected, {
      kind: "retry_scheduled",
      operationId: operation.id,
      code: "EXPORT_RESULT_RECOVERY_PENDING",
    });
    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-requested");
    assert.equal(store.operations.get(operation.id)?.state, "failed_retryable");

    provisioner.failure = null;
    await store.makeRunnable(TENANT);
    await convergeProvision(reconciler, TENANT, 8);
    assert.equal(store.operations.get(operation.id)?.state, "succeeded");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
  });

  it("does not report an active cell ready without a current readiness proof", async () => {
    const { store, reconciler } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const cell = store.cells.get(cellId);
    assert.ok(cell);
    cell.readinessCode = null;

    const status = store.statusForTenant(TENANT);
    assert.equal(status.state, "preparing");
    assert.equal(status.code, "CELL_PREPARING");
    assert.equal(status.retryable, true);
  });

  it("quarantines and cleans an export that expires in flight across a lost release acknowledgement", async () => {
    const { store, reconciler, provisioner, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);

    const operation = await store.enqueue(TENANT, "export", "export-expired-in-flight", cellId);
    const storedOperation = store.operations.get(operation.id);
    assert.ok(storedOperation);
    storedOperation.exportExpiresAt = new Date(nowState.value.getTime() + 1);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    provisioner.export = async (request) => {
      const result = await createExport(request);
      nowState.value = new Date(request.expiresAt.getTime() + 1);
      assert.equal(nowState.value > request.expiresAt, true);
      return result;
    };
    provisioner.loseNextAcknowledgement("release-export");

    const first = await reconciler.reconcileOne({ owner: "expired-export", tenantId: TENANT });

    assert.equal(first.kind, "retry_scheduled");
    assert.deepEqual(
      (({ state, checkpoint, attempts, errorCode }) => ({
        state,
        checkpoint,
        attempts,
        errorCode,
      }))(store.operations.get(operation.id)!),
      {
        state: "failed_retryable",
        checkpoint: "export-expired-release",
        attempts: 1,
        errorCode: "EXPIRED_EXPORT_RELEASE_PENDING",
      }
    );
    assert.equal(store.exports.has(operation.id), true);
    assert.notEqual(store.operations.get(operation.id)?.exportReleaseEnvelope, null);
    assert.equal(provisioner.exportArtifacts.size, 0);

    await store.makeRunnable(TENANT);
    const released = await reconciler.reconcileOne({
      owner: "expired-export-retry",
      tenantId: TENANT,
    });
    assert.deepEqual(released, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "export-expired-released",
    });
    assert.equal(
      provisioner.calls.filter(
        (call) =>
          call.action === "release-export" && call.idempotencyKey.includes("export-expired-release")
      ).length,
      2,
      JSON.stringify({
        calls: provisioner.calls,
        released,
        operation: store.operations.get(operation.id),
      })
    );
    assert.equal(store.operations.get(operation.id)?.exportReleaseEnvelope, null);
    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-expired-released");
    assert.equal(store.operations.get(operation.id)?.state, "waiting");

    await convergeProvision(reconciler, TENANT, 6);

    assert.equal(store.operations.get(operation.id)?.state, "failed_terminal");
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
    assert.equal(
      provisioner.calls.some(
        (call) => call.action === "resume" && call.idempotencyKey.startsWith(operation.id)
      ),
      true
    );
  });

  it("accepts repeated provider-pending responses while releasing an expired export", async () => {
    class PendingExpiredReleaseProvisioner extends FakeCellProvisioner {
      remaining = 8;

      override async releaseExport(
        request: Parameters<FakeCellProvisioner["releaseExport"]>[0]
      ): Promise<void> {
        if (request.context.checkpoint === "export-expired-release" && this.remaining > 0) {
          this.remaining -= 1;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          });
        }
        return super.releaseExport(request);
      }
    }

    const providerClock = { value: new Date("2026-07-12T12:00:00.000Z") };
    const provisioner = new PendingExpiredReleaseProvisioner({ now: () => providerClock.value });
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    providerClock.value = nowState.value;
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "export", "expired-release-pending", cellId);
    const storedOperation = store.operations.get(operation.id);
    assert.ok(storedOperation);
    storedOperation.exportExpiresAt = new Date(nowState.value.getTime() + 1);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    provisioner.export = async (request) => {
      const result = await createExport(request);
      nowState.value = new Date(request.expiresAt.getTime() + 1);
      providerClock.value = nowState.value;
      return result;
    };

    for (let poll = 0; poll < 8; poll += 1) {
      const result = await reconciler.reconcileOne({ owner: `pending-${poll}`, tenantId: TENANT });
      assert.equal(result.kind, "retry_scheduled");
      const current = store.operations.get(operation.id);
      assert.equal(current?.checkpoint, "export-expired-release");
      assert.equal(current?.state, "waiting");
      assert.equal(current?.attempts, 0);
      nowState.value = new Date(nowState.value.getTime() + 2_001);
      providerClock.value = nowState.value;
    }

    const completed = await reconciler.reconcileOne({
      owner: "pending-complete",
      tenantId: TENANT,
    });
    assert.deepEqual(completed, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "export-expired-released",
    });
    assert.equal(store.operations.get(operation.id)?.exportReleaseEnvelope, null);

    await convergeProvision(reconciler, TENANT, 6);

    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(provisioner.exportArtifacts.size, 0);
  });

  it("accepts provider-pending resume and readiness while restoring an expired export", async () => {
    class PendingExpiredRestorationProvisioner extends FakeCellProvisioner {
      resumePending = true;
      readinessPending = true;

      override async resume(request: Parameters<FakeCellProvisioner["resume"]>[0]): Promise<void> {
        if (request.context.checkpoint === "export-expired-released" && this.resumePending) {
          this.resumePending = false;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          });
        }
        return super.resume(request);
      }

      override async health(request: Parameters<FakeCellProvisioner["health"]>[0]) {
        if (request.context.checkpoint === "export-expired-resumed" && this.readinessPending) {
          this.readinessPending = false;
          throw new ProvisionerPending({
            operationId: request.context.operationId,
            checkpoint: request.context.checkpoint,
            retryAfterSeconds: 2,
          });
        }
        return super.health(request);
      }
    }

    const providerClock = { value: new Date("2026-07-12T12:00:00.000Z") };
    const provisioner = new PendingExpiredRestorationProvisioner({
      now: () => providerClock.value,
    });
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    providerClock.value = nowState.value;
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "export", "expired-restoration-pending", cellId);
    const storedOperation = store.operations.get(operation.id);
    assert.ok(storedOperation);
    storedOperation.exportExpiresAt = new Date(nowState.value.getTime() + 1);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    provisioner.export = async (request) => {
      const result = await createExport(request);
      nowState.value = new Date(request.expiresAt.getTime() + 1);
      providerClock.value = nowState.value;
      return result;
    };

    assert.deepEqual(
      await reconciler.reconcileOne({ owner: "release-complete", tenantId: TENANT }),
      {
        kind: "advanced",
        operationId: operation.id,
        checkpoint: "export-expired-released",
      }
    );
    assert.equal(store.operations.get(operation.id)?.exportReleaseEnvelope, null);

    const resumePending = await reconciler.reconcileOne({
      owner: "resume-pending",
      tenantId: TENANT,
    });
    assert.equal(resumePending.kind, "retry_scheduled");
    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-expired-released");
    assert.equal(store.operations.get(operation.id)?.attempts, 0);
    nowState.value = new Date(nowState.value.getTime() + 2_001);
    providerClock.value = nowState.value;

    assert.deepEqual(
      await reconciler.reconcileOne({ owner: "resume-complete", tenantId: TENANT }),
      {
        kind: "advanced",
        operationId: operation.id,
        checkpoint: "export-expired-resumed",
      }
    );

    const readinessPending = await reconciler.reconcileOne({
      owner: "readiness-pending",
      tenantId: TENANT,
    });
    assert.equal(readinessPending.kind, "retry_scheduled");
    assert.equal(store.operations.get(operation.id)?.checkpoint, "export-expired-resumed");
    assert.equal(store.operations.get(operation.id)?.attempts, 0);
    nowState.value = new Date(nowState.value.getTime() + 2_001);
    providerClock.value = nowState.value;

    assert.deepEqual(
      await reconciler.reconcileOne({ owner: "readiness-complete", tenantId: TENANT }),
      {
        kind: "advanced",
        operationId: operation.id,
        checkpoint: "export-expired-readiness-proved",
      }
    );

    const completed = await reconciler.reconcileOne({
      owner: "restoration-complete",
      tenantId: TENANT,
    });
    assert.equal(completed.kind, "terminal");
    assert.equal(store.statusForTenant(TENANT).state, "ready");
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(store.operations.get(operation.id)?.exportReleaseEnvelope, null);
  });

  it("clears the release handle before restoration retries beyond the attempt cap", async () => {
    class FailingExpiredRestorationProvisioner extends FakeCellProvisioner {
      remaining = 8;

      override async resume(request: Parameters<FakeCellProvisioner["resume"]>[0]): Promise<void> {
        if (request.context.checkpoint === "export-expired-released" && this.remaining > 0) {
          this.remaining -= 1;
          throw new ProvisionerFailure({ code: "PROVISIONER_TIMEOUT", retryable: true });
        }
        return super.resume(request);
      }
    }

    const providerClock = { value: new Date("2026-07-12T12:00:00.000Z") };
    const provisioner = new FailingExpiredRestorationProvisioner({
      now: () => providerClock.value,
    });
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    providerClock.value = nowState.value;
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "export", "expired-restoration-retries", cellId);
    const storedOperation = store.operations.get(operation.id);
    assert.ok(storedOperation);
    storedOperation.exportExpiresAt = new Date(nowState.value.getTime() + 1);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    provisioner.export = async (request) => {
      const result = await createExport(request);
      nowState.value = new Date(request.expiresAt.getTime() + 1);
      providerClock.value = nowState.value;
      return result;
    };

    assert.deepEqual(
      await reconciler.reconcileOne({ owner: "release-complete", tenantId: TENANT }),
      {
        kind: "advanced",
        operationId: operation.id,
        checkpoint: "export-expired-released",
      }
    );
    assert.equal(store.operations.get(operation.id)?.exportReleaseEnvelope, null);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await reconciler.reconcileOne({
        owner: `restoration-failure-${attempt}`,
        tenantId: TENANT,
      });
      assert.equal(result.kind, "retry_scheduled");
      const current = store.operations.get(operation.id);
      assert.equal(current?.checkpoint, "export-expired-released");
      assert.equal(current?.state, "failed_retryable");
      assert.equal(current?.errorCode, "EXPIRED_EXPORT_RESTORATION_PENDING");
      assert.equal(current?.exportReleaseEnvelope, null);
      await store.makeRunnable(TENANT);
    }

    await convergeProvision(reconciler, TENANT, 6);

    assert.equal(store.statusForTenant(TENANT).state, "ready");
    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(
      provisioner.calls.filter(
        (call) => call.action === "release-export" && call.idempotencyKey.startsWith(operation.id)
      ).length,
      1
    );
  });

  it("retries expired export release beyond the ordinary attempt cap", async () => {
    class FailingExpiredReleaseProvisioner extends FakeCellProvisioner {
      remaining = 8;

      override async releaseExport(
        request: Parameters<FakeCellProvisioner["releaseExport"]>[0]
      ): Promise<void> {
        if (request.context.checkpoint === "export-expired-release" && this.remaining > 0) {
          this.remaining -= 1;
          throw new ProvisionerFailure({ code: "PROVISIONER_TIMEOUT", retryable: true });
        }
        return super.releaseExport(request);
      }
    }

    const providerClock = { value: new Date("2026-07-12T12:00:00.000Z") };
    const provisioner = new FailingExpiredReleaseProvisioner({ now: () => providerClock.value });
    const { store, reconciler, nowState } = harness(undefined, async () => true, provisioner);
    providerClock.value = nowState.value;
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    const operation = await store.enqueue(TENANT, "export", "expired-release-retries", cellId);
    const storedOperation = store.operations.get(operation.id);
    assert.ok(storedOperation);
    storedOperation.exportExpiresAt = new Date(nowState.value.getTime() + 1);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    provisioner.export = async (request) => {
      const result = await createExport(request);
      nowState.value = new Date(request.expiresAt.getTime() + 1);
      providerClock.value = nowState.value;
      return result;
    };

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const result = await reconciler.reconcileOne({
        owner: `failure-${attempt}`,
        tenantId: TENANT,
      });
      assert.equal(result.kind, "retry_scheduled");
      const current = store.operations.get(operation.id);
      assert.equal(current?.checkpoint, "export-expired-release");
      assert.equal(current?.state, "failed_retryable");
      assert.equal(current?.errorCode, "EXPIRED_EXPORT_RELEASE_PENDING");
      await store.makeRunnable(TENANT);
    }

    const completed = await reconciler.reconcileOne({
      owner: "failure-complete",
      tenantId: TENANT,
    });
    assert.deepEqual(completed, {
      kind: "advanced",
      operationId: operation.id,
      checkpoint: "export-expired-released",
    });
    assert.equal(store.operations.get(operation.id)?.exportReleaseEnvelope, null);

    await convergeProvision(reconciler, TENANT, 6);

    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(provisioner.exportArtifacts.size, 0);
  });

  it("returns an expired export from a suspended tenant to a quiesced cell", async () => {
    const { store, reconciler, provisioner, nowState } = harness();
    await store.enqueue(TENANT, "provision", "initial-provision");
    await convergeProvision(reconciler);
    const cellId = store.tenants.get(TENANT)?.boundCellId;
    assert.ok(cellId);
    await store.enqueue(TENANT, "suspend", "suspend-before-expired-export", cellId);
    await convergeProvision(reconciler);

    const operation = await store.enqueue(TENANT, "export", "suspended-expired-export", cellId);
    const storedOperation = store.operations.get(operation.id);
    assert.ok(storedOperation);
    storedOperation.exportExpiresAt = new Date(nowState.value.getTime() + 1);
    await reconciler.reconcileOne({ owner: "gate", tenantId: TENANT });
    await reconciler.reconcileOne({ owner: "quiesce", tenantId: TENANT });
    const createExport = provisioner.export.bind(provisioner);
    provisioner.export = async (request) => {
      const result = await createExport(request);
      nowState.value = new Date(request.expiresAt.getTime() + 1);
      return result;
    };

    await convergeProvision(reconciler, TENANT, 8);

    assert.equal(store.operations.get(operation.id)?.errorCode, "EXPORT_EXPIRED");
    assert.equal(store.statusForTenant(TENANT).state, "suspended");
    assert.equal(store.cells.get(cellId)?.lifecycleState, "quiesced");
    assert.equal(
      provisioner.calls.some(
        (call) => call.action === "resume" && call.idempotencyKey.startsWith(operation.id)
      ),
      false
    );
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
