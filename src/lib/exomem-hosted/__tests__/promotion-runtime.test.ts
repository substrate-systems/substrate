import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  promotionHealthTarget,
  PromotionRuntimePreconditionError,
  preparePromotionRuntimeHealth,
  recordPromotionRuntimeAuthorityInTransaction,
  strictOuterV2ReadinessMismatch,
  type PromotionProbe,
} from "../promotion-runtime";
import { __setExomemSqlForTests } from "../db";
import { PROVISIONER_PROTOCOL_V2, type CellReadiness } from "../provisioner";
import type { CellControlRecord, LifecycleOperation, LifecycleTarget } from "../reconciler";
import { routableSetDigest } from "../routable-authority";
import { digestSecret, encryptSecret } from "../security";

const target: LifecycleTarget = {
  candidateId: "candidate-1",
  assignmentId: "assignment-1",
  assignmentGeneration: 1,
  sourceRelease: "0.49.0",
  protocolVersion: "1",
  gatewayContractDigest: "a".repeat(64),
  commandFingerprint: "b".repeat(64),
  schemaDigest: "c".repeat(64),
  compatibilityDigest: "d".repeat(64),
};
const key = Buffer.alloc(32, 1);
const cell: CellControlRecord = {
  id: "cell-1",
  tenantId: "tenant-1",
  lifecycleState: "active",
  routingState: "bound",
  desiredState: "running",
  protocolVersion: target.protocolVersion,
  releaseVersion: target.sourceRelease,
  workerPolicy: { workerCount: 1, semantic: true, media: false },
  providerRef: "provider-1",
  endpointEnvelope: null,
  credentialEnvelope: encryptSecret("service-credential", {
    key,
    randomBytes: () => Buffer.alloc(12, 2),
  }),
  credentialDigest: digestSecret("service-credential"),
  credentialVersion: 1,
  pendingCredentialEnvelope: null,
  pendingCredentialDigest: null,
  pendingCredentialVersion: null,
  readinessCode: "CELL_READY",
};
const operation: LifecycleOperation = {
  id: "operation-1",
  tenantId: cell.tenantId,
  cellId: cell.id,
  operationType: "provision",
  provisionerWireProtocol: PROVISIONER_PROTOCOL_V2,
  state: "succeeded",
  idempotencyKey: "provision-1",
  fenceGeneration: 3,
  checkpoint: "bound",
  requestId: "request-1",
  attempts: 1,
  nextAttemptAt: new Date(),
  leaseOwner: null,
  leaseExpiresAt: null,
  errorCode: null,
  providerResultRef: "provider-result-1",
  inputReferenceEnvelope: null,
  inputReferenceDigest: null,
  inputExportId: null,
  exportReleaseEnvelope: null,
  exportReleaseDigest: null,
  exportExpiresAt: null,
  exportRequestStarted: false,
  inputSourceCellId: null,
  inputArchiveSha256: null,
  inputManifestSha256: null,
  inputArchiveSize: null,
  resumeAfterOperation: true,
  expectedPreviousCellId: null,
  target,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const readiness: CellReadiness = {
  live: true,
  ready: true,
  cellId: cell.id,
  protocolVersion: target.protocolVersion,
  releaseVersion: target.sourceRelease,
  serviceAuthenticated: true,
  mutationAuthority: true,
  readAdmission: true,
  writeAdmission: true,
  workerPolicy: cell.workerPolicy,
  runtimeIdentity: {
    releaseVersion: target.sourceRelease,
    protocolVersion: target.protocolVersion,
    agentProfile: "hosted-alpha-agent-v1",
    gatewayContractDigest: target.gatewayContractDigest,
    commandFingerprint: target.commandFingerprint,
    schemaDigest: target.schemaDigest,
    compatibilityDigest: target.compatibilityDigest,
  },
  code: "CELL_READY",
};

afterEach(() => __setExomemSqlForTests(null));

describe("promotion runtime", () => {
  it("constructs outer-v2 health only from persisted target and cell inputs", () => {
    const request = promotionHealthTarget({ operation, cell, envelopeKey: key });
    assert.ok(request);
    assert.equal(request.providerRef, cell.providerRef);
    assert.equal(request.serviceCredential.reveal(), "service-credential");
    assert.deepEqual(request.runtimeTarget, {
      releaseVersion: target.sourceRelease,
      protocolVersion: target.protocolVersion,
      agentProfile: "hosted-alpha-agent-v1",
      gatewayContractDigest: target.gatewayContractDigest,
      commandFingerprint: target.commandFingerprint,
      schemaDigest: target.schemaDigest,
      compatibilityDigest: target.compatibilityDigest,
    });
    assert.deepEqual(request.context, {
      operationId: operation.id,
      checkpoint: "promote-cohort-health",
      idempotencyKey: `${operation.id}:promote-cohort-health:${cell.id}`,
      fenceGeneration: operation.fenceGeneration,
    });
  });

  it("accepts a completed rollforward as persisted promotion authority", () => {
    const request = promotionHealthTarget({
      operation: { ...operation, operationType: "rollforward", checkpoint: "complete" },
      cell,
      envelopeKey: key,
    });
    assert.ok(request);
    assert.equal(request.runtimeTarget?.releaseVersion, target.sourceRelease);
  });

  it("rejects non-v2 or targetless cells before health", () => {
    assert.equal(
      promotionHealthTarget({
        operation: { ...operation, provisionerWireProtocol: "exomem-cell-provisioner.v1" },
        cell,
        envelopeKey: key,
      }),
      null
    );
    assert.equal(
      promotionHealthTarget({ operation: { ...operation, target: null }, cell, envelopeKey: key }),
      null
    );
  });

  it("rejects absent or mismatched persisted service credential digests before health", () => {
    assert.equal(
      promotionHealthTarget({
        operation,
        cell: { ...cell, credentialDigest: null },
        envelopeKey: key,
      }),
      null
    );
    assert.equal(
      promotionHealthTarget({
        operation,
        cell: { ...cell, credentialDigest: digestSecret("different-credential") },
        envelopeKey: key,
      }),
      null
    );
  });

  it("uses reconciler-equivalent strict readiness comparison", () => {
    assert.equal(strictOuterV2ReadinessMismatch(readiness, cell, operation), false);
    assert.equal(
      strictOuterV2ReadinessMismatch({ ...readiness, live: false }, cell, operation),
      false
    );
    assert.equal(
      strictOuterV2ReadinessMismatch({ ...readiness, ready: false }, cell, operation),
      false
    );
    assert.equal(
      strictOuterV2ReadinessMismatch(
        {
          ...readiness,
          runtimeIdentity: { ...readiness.runtimeIdentity!, schemaDigest: "e".repeat(64) },
        },
        cell,
        operation
      ),
      true
    );
    assert.equal(
      strictOuterV2ReadinessMismatch(
        {
          ...readiness,
          runtimeIdentity: {
            ...readiness.runtimeIdentity!,
            compatibilityDigest: "e".repeat(64),
          },
        },
        cell,
        operation
      ),
      true
    );
    assert.equal(
      strictOuterV2ReadinessMismatch(
        { ...readiness, workerPolicy: { ...cell.workerPolicy, media: true } },
        cell,
        operation
      ),
      true
    );
  });

  it("fails closed before health when no current routable outer-v2 proof exists", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [] };
    });
    let healthCalled = false;
    assert.equal(
      await preparePromotionRuntimeHealth({
        candidateId: target.candidateId,
        expectedRoutableCellDigest: "a".repeat(64),
        provisioner: {
          health: async () => {
            healthCalled = true;
            return readiness;
          },
        },
        envelopeKey: key,
      }),
      null
    );
    assert.equal(healthCalled, false);
    assert.match(statement, /operation_type = 'rollforward'/i);
    assert.match(statement, /operation\.checkpoint = 'complete'/i);
  });

  it("does not refresh authority when the route set changes after health and before promotion", async () => {
    const probe: PromotionProbe = {
      route: {
        cell_id: cell.id,
        source_release: target.sourceRelease,
        protocol_version: target.protocolVersion,
        command_fingerprint: target.commandFingerprint,
        contract_digest: target.schemaDigest,
        compatibility_digest: target.compatibilityDigest,
      },
      cell,
      operation,
      readiness,
    };
    let refreshCalled = false;
    const recorded = await recordPromotionRuntimeAuthorityInTransaction({
      transaction: async (strings) => {
        assert.match(strings.join("?"), /lock-promotion-runtime-route-set/);
        return {
          rows: [
            {
              ...probe.route,
              compatibility_digest: "e".repeat(64),
            },
          ],
        };
      },
      candidateId: target.candidateId,
      expectedRoutableCellDigest: routableSetDigest("hosted-alpha-agent-v1", [probe.route]),
      probes: [probe],
      refreshAuthority: async () => {
        refreshCalled = true;
      },
    });
    assert.equal(recorded, false);
    assert.equal(refreshCalled, false);
  });

  it("does not record a probe after its persisted credential/runtime inputs change", async () => {
    const probe: PromotionProbe = {
      route: {
        cell_id: cell.id,
        source_release: target.sourceRelease,
        protocol_version: target.protocolVersion,
        command_fingerprint: target.commandFingerprint,
        contract_digest: target.schemaDigest,
        compatibility_digest: target.compatibilityDigest,
      },
      cell,
      operation,
      readiness,
    };
    let refreshCalled = false;
    await assert.rejects(
      () =>
        recordPromotionRuntimeAuthorityInTransaction({
          transaction: async (strings) => {
            const query = strings.join("?");
            if (query.includes("lock-promotion-runtime-route-set")) return { rows: [probe.route] };
            assert.match(query, /exomem_cells\.provider_ref =/);
            assert.match(query, /exomem_cells\.credential_version =/);
            assert.match(query, /exomem_cells\.worker_policy =/);
            assert.match(query, /exomem_cells\.protocol_version =/);
            assert.match(query, /exomem_cells\.release_version =/);
            assert.match(query, /exomem_cells\.service_credential_ciphertext =/);
            return { rows: [] };
          },
          candidateId: target.candidateId,
          expectedRoutableCellDigest: routableSetDigest("hosted-alpha-agent-v1", [probe.route]),
          probes: [probe],
          refreshAuthority: async () => {
            refreshCalled = true;
          },
        }),
      PromotionRuntimePreconditionError
    );
    assert.equal(refreshCalled, false);
  });
});
