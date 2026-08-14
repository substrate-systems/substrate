import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  consumeDeletionConfirmationAtomic,
  type ExomemSql,
} from "../db";
import { getExomemHostedContractionReadiness, SqlLifecycleStore } from "../lifecycle-store";
import { exomemContractFixture0490 } from "../gateway-contract-0-49-0";
import { exomemContractFixture0500 } from "../gateway-contract-0-50-0";
import { normalizeProvisionerWireProtocol } from "../provisioner-wire-protocol";

afterEach(() => {
  __setExomemSqlForTests(null);
  __setExomemTransactionForTests(null);
});

describe("SQL lifecycle operation store", () => {
  it("reports only durable v1 drain counts for contraction readiness", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return {
        rows: [{ unfinished_v1_operations: "2", retained_v1_exports: "1" }],
        rowCount: 1,
      };
    });

    assert.deepEqual(await getExomemHostedContractionReadiness(), {
      ready: false,
      unfinishedV1Operations: 2,
      retainedV1Exports: 1,
    });
    assert.match(statement, /operation\.provisioner_wire_protocol = 'exomem-cell-provisioner\.v1'/i);
    assert.match(statement, /operation\.state NOT IN \('succeeded', 'failed_terminal'\)/i);
    assert.match(statement, /export_row\.state <> 'deleted'/i);
    assert.match(statement, /JOIN exomem_lifecycle_operations AS operation/i);
  });

  it("defaults new operations to v1 and enables v2 only for normalized true", () => {
    assert.equal(normalizeProvisionerWireProtocol(undefined), "exomem-cell-provisioner.v1");
    assert.equal(normalizeProvisionerWireProtocol(""), "exomem-cell-provisioner.v1");
    assert.equal(normalizeProvisionerWireProtocol("false"), "exomem-cell-provisioner.v1");
    assert.equal(normalizeProvisionerWireProtocol("1"), "exomem-cell-provisioner.v1");
    assert.equal(normalizeProvisionerWireProtocol(" TrUe "), "exomem-cell-provisioner.v2");
  });

  it("records v2 runtime observations but derives compatibility from the stored target", async () => {
    let statement = "";
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      statement = strings.join("?");
      values.push(...parameters);
      return { rows: [{ id: "cell-1" }], rowCount: 1 };
    });

    const recorded = await new SqlLifecycleStore().recordReadiness({
      operationId: "018f2d91-7c42-7000-8000-000000000071",
      owner: "worker-a",
      code: "CELL_READY",
      runtimeIdentity: {
        releaseVersion: "2026.07.11",
        protocolVersion: "1",
        agentProfile: "hosted-alpha-agent-v1",
        gatewayContractDigest: "a".repeat(64),
        commandFingerprint: "b".repeat(64),
        schemaDigest: "c".repeat(64),
      },
    });

    assert.equal(recorded, true);
    assert.match(statement, /operation\.provisioner_wire_protocol = 'exomem-cell-provisioner\.v2'/i);
    assert.match(statement, /operation\.target_compatibility_digest/i);
    assert.equal(values.includes("a".repeat(64)), true);
    assert.equal(values.includes("b".repeat(64)), true);
    assert.equal(values.includes("c".repeat(64)), true);
  });

  it("claims pending work or a stale running lease with row locking and an attempt bound", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [], rowCount: 0 };
    });
    const store = new SqlLifecycleStore();
    await store.claim({
      owner: "worker-opaque",
      leaseMs: 15_000,
      maxAttempts: 6,
      tenantId: "018f2d91-7c42-7000-8000-000000000071",
    });

    assert.match(statement, /FOR UPDATE(?: OF operation)? SKIP LOCKED/i);
    assert.match(statement, /state = 'running'/i);
    assert.match(statement, /lease_expires_at <= now\(\)/i);
    assert.match(statement, /attempts <=/i);
    assert.match(statement, /'export-requested'/i);
    assert.match(statement, /'export-expired-release'/i);
    assert.match(statement, /export_release_reference_ciphertext IS NOT NULL/i);
    assert.match(statement, /attempts = attempts \+ 1/i);
  });

  it("advances checkpoints only for the current unexpired lease owner and expected checkpoint", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });
    const store = new SqlLifecycleStore();
    assert.equal(
      await store.advance("operation-1", "worker-a", "provider-converged", "readiness-proved"),
      true
    );
    assert.match(statement, /lease_owner =/i);
    assert.match(statement, /lease_expires_at > now\(\)/i);
    assert.match(statement, /checkpoint =/i);
    assert.match(statement, /state = 'waiting'/i);
    assert.match(statement, /lease_owner = NULL/i);
  });

  it("durably waits on an echoed provider checkpoint without consuming an attempt", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });
    const store = new SqlLifecycleStore();
    assert.equal(
      await store.waitForProvider(
        "operation-1",
        "worker-a",
        "candidate-created",
        new Date("2026-07-14T12:00:02.000Z")
      ),
      true
    );
    assert.match(statement, /state = 'waiting'/i);
    assert.match(statement, /attempts = GREATEST\(attempts - 1, 0\)/i);
    assert.match(statement, /checkpoint =/i);
    assert.match(statement, /error_code = NULL/i);
    assert.match(statement, /lease_owner = NULL/i);
  });

  it("persists export intent under the active lease before the provider call", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });
    const store = new SqlLifecycleStore();

    const expiresAt = new Date("2026-07-15T12:00:00.000Z");
    assert.equal(await store.beginExport("operation-1", "worker-a", expiresAt), true);
    assert.match(statement, /operation_type = 'export'/i);
    assert.match(statement, /operation\.checkpoint IN\s*\('quiesced', 'export-requested'\)/i);
    assert.match(
      statement,
      /export_expires_at = date_trunc\(\s*'milliseconds',\s*COALESCE\(operation\.export_expires_at/i
    );
    assert.match(statement, /export_request_started = true/i);
    assert.match(statement, /checkpoint = 'export-requested'/i);
    assert.match(statement, /date_trunc\('milliseconds', operation\.export_expires_at\)/i);
    assert.match(statement, /lease_owner =/i);
    assert.match(statement, /lease_expires_at > now\(\)/i);
    assert.match(statement, /export_release_reference_ciphertext IS NULL/i);
    assert.equal(statement.includes("export_expires_at"), true);
  });

  it("atomically marks an in-flight expired export for deletion instead of publishing it", async () => {
    let statement = "";
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      statement = strings.join("?");
      values.push(...parameters);
      return { rows: [{ disposition: "expired" }], rowCount: 1 };
    });
    const store = new SqlLifecycleStore();
    const expiresAt = new Date("2026-07-15T12:00:00.000Z");

    assert.equal(
      await store.recordExportResult({
        operationId: "018f2d91-7c42-7000-8000-000000000070",
        owner: "worker-a",
        tenantId: "018f2d91-7c42-7000-8000-000000000071",
        cellId: "018f2d91-7c42-7000-8000-000000000072",
        storageReferenceEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "storage-iv",
          ciphertext: "storage-ciphertext",
          tag: "storage-tag",
        },
        storageReferenceDigest: Buffer.alloc(32, 0x71),
        releaseReferenceEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "release-iv",
          ciphertext: "release-ciphertext",
          tag: "release-tag",
        },
        releaseReferenceDigest: Buffer.alloc(32, 0x72),
        archiveSha256: "a".repeat(64),
        manifestSha256: "b".repeat(64),
        archiveSize: 1024,
        encryptionScheme: "envelope-aes-256-gcm",
        integrityVerified: true,
        expiresAt,
      }),
      "expired"
    );

    assert.match(statement, /operation\.lease_expires_at > now\(\)/i);
    assert.match(statement, /operation\.checkpoint IN\s*\('quiesced', 'export-requested'\)/i);
    assert.match(statement, /operation\.export_request_started/i);
    assert.match(statement, /operation\.export_expires_at = \?::timestamptz/i);
    assert.equal(values.includes(expiresAt.toISOString()), true);
    assert.match(statement, /CASE[\s\S]*WHEN \?::timestamptz > now\(\)[\s\S]*'available'/i);
    assert.match(statement, /ELSE 'deleting'/i);
    assert.match(statement, /expires_at = EXCLUDED\.expires_at/i);
    assert.match(statement, /checkpoint = CASE[\s\S]*'export-expired-release'/i);
    assert.match(statement, /SELECT disposition FROM release_recorded/i);
    assert.match(statement, /FROM owned[\s\S]*ON CONFLICT \(operation_id\)/i);
  });

  it("atomically clears an expired release handle before restoration", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });

    assert.equal(
      await new SqlLifecycleStore().acknowledgeExpiredExportRelease(
        "018f2d91-7c42-7000-8000-000000000070",
        "worker-a"
      ),
      true
    );
    assert.match(statement, /checkpoint = 'export-expired-release'/i);
    assert.match(statement, /checkpoint = 'export-expired-released'/i);
    assert.match(statement, /lease_owner =/i);
    assert.match(statement, /lease_expires_at > now\(\)/i);
    assert.match(statement, /export_release_reference_ciphertext = NULL/i);
    assert.match(statement, /state = 'waiting'/i);
    assert.match(statement, /next_attempt_at = now\(\)/i);
    assert.doesNotMatch(statement, /state = 'failed_terminal'/i);
    assert.match(statement, /tenant\.fence_generation = operation\.fence_generation/i);
  });

  it("terminalizes only after the expired export's prior state is restored", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });

    assert.equal(
      await new SqlLifecycleStore().completeExpiredExportRestoration(
        "018f2d91-7c42-7000-8000-000000000070",
        "worker-a"
      ),
      true
    );
    assert.match(statement, /export_release_reference_ciphertext IS NULL/i);
    assert.match(statement, /state = 'failed_terminal'/i);
    assert.match(statement, /error_code = 'EXPORT_EXPIRED'/i);
    assert.match(statement, /completed_at = now\(\)/i);
    assert.match(statement, /lease_owner = NULL/i);
    assert.match(statement, /checkpoint = 'export-expired-released'/i);
    assert.match(statement, /checkpoint = 'export-expired-readiness-proved'/i);
    assert.match(statement, /cell\.readiness_code = 'CELL_READY'/i);
    assert.match(statement, /tenant\.fence_generation = operation\.fence_generation/i);
  });

  it("fences the transition into mandatory expired-export release recovery", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });

    assert.equal(
      await new SqlLifecycleStore().prepareExpiredExportRelease(
        "018f2d91-7c42-7000-8000-000000000070",
        "worker-a"
      ),
      true
    );
    assert.match(statement, /checkpoint = 'export-expired-release'/i);
    assert.match(statement, /operation\.checkpoint IN\s*\('quiesced', 'export-requested'\)/i);
    assert.match(statement, /export_release_reference_ciphertext IS NOT NULL/i);
    assert.match(statement, /operation\.lease_expires_at > now\(\)/i);
    assert.match(statement, /tenant\.fence_generation = operation\.fence_generation/i);
  });

  it("atomically binds billing proof to the one deletion checkpoint transition", async () => {
    let statement = "";
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
      return { rows: [{ id: "operation-1" }], rowCount: 1 };
    });
    const store = new SqlLifecycleStore();
    assert.equal(
      await store.advanceBillingTerminated({
        operationId: "018f2d91-7c42-7000-8000-000000000070",
        owner: "billing-worker",
        proof: {
          tenantId: "018f2d91-7c42-7000-8000-000000000071",
          userId: "018f2d91-7c42-7000-8000-000000000072",
          source: "paddle",
          sourceState: "active",
          sourceRevision: "evt_exact",
          providerEnvironment: "sandbox",
          customerRef: "ctm_exact",
          subscriptionRef: "sub_exact",
          transactionRef: "txn_exact",
        },
      }),
      true
    );

    assert.match(statement, /operation\.operation_type = 'delete'/i);
    assert.match(statement, /operation\.checkpoint = 'quiesced'/i);
    assert.match(statement, /operation\.lease_owner =/i);
    assert.match(statement, /operation\.lease_expires_at > now\(\)/i);
    assert.match(statement, /operation\.fence_generation = tenant\.fence_generation/i);
    assert.match(statement, /tenant\.status = 'deletion_pending'/i);
    assert.match(statement, /tenant\.desired_state = 'deleted'/i);
    assert.match(statement, /IS NOT DISTINCT FROM/g);
    assert.match(statement, /FOR UPDATE OF operation, tenant, entitlement/i);
    assert.match(statement, /provider_subscription_ref = NULL/i);
    assert.match(statement, /provider_transaction_ref = NULL/i);
    assert.match(statement, /checkpoint = 'billing-quiesced'/i);
    assert.match(statement, /matching[\s\S]*entitlement_marked[\s\S]*operation_advanced/i);
  });

  it("creates or adopts one operation-owned unbound candidate atomically", async () => {
    let statement = "";
    const sql: ExomemSql = async (strings) => {
      statement = strings.join("?");
      return { rows: [], rowCount: 0 };
    };
    __setExomemSqlForTests(sql);
    const store = new SqlLifecycleStore();
    await store.ensureCandidate({
      operationId: "018f2d91-7c42-7000-8000-000000000072",
      owner: "worker-a",
      protocolVersion: "1",
      releaseVersion: "2026.07.12",
      workerPolicy: { workerCount: 0, semantic: false, media: false },
      credential: {
        plaintext: "never-persist-this-credential",
        envelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "opaque-iv",
          ciphertext: "opaque-ciphertext",
          tag: "opaque-tag",
        },
        digest: Buffer.alloc(32, 0x71),
      },
      lifecycleState: "provisioning",
    });

    assert.match(statement, /FOR UPDATE/i);
    assert.match(statement, /INSERT INTO exomem_cells/i);
    assert.match(statement, /routing_state/i);
    assert.match(statement, /expected_previous_cell_id/i);
    assert.match(statement, /UPDATE exomem_lifecycle_operations/i);
    assert.equal(statement.includes("never-persist-this-credential"), false);
  });

  it("atomically pins an owner restore to a same-tenant unexpired export", async () => {
    let statement = "";
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      statement = strings.join("?");
      values.push(...parameters);
      return { rows: [] };
    });
    const store = new SqlLifecycleStore();
    await assert.rejects(
      store.enqueue("018f2d91-7c42-7000-8000-000000000071", "restore", "restore-pinned", null, {
        inputReferenceEnvelope: {
          version: 1,
          algorithm: "A256GCM",
          iv: "opaque-iv",
          ciphertext: "opaque-ciphertext",
          tag: "opaque-tag",
        },
        inputReferenceDigest: Buffer.alloc(32, 0x71),
        restoreBinding: {
          exportId: "018f2d91-7c42-7000-8000-000000000072",
          sourceCellId: "018f2d91-7c42-7000-8000-000000000073",
          archiveSha256: "a".repeat(64),
          manifestSha256: "b".repeat(64),
          archiveSize: 1024,
        },
      })
    );
    assert.match(statement, /export_row\.state = 'available'/);
    assert.match(statement, /export_row\.expires_at > now\(\)/);
    assert.match(statement, /FOR UPDATE OF export_row/);
    assert.match(statement, /input_export_id/);
    assert.match(statement, /source_export\.storage_reference_ciphertext/);
    assert.match(statement, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    assert.equal(
      values.includes(
        `${exomemContractFixture0490.release}:${exomemContractFixture0490.protocol}`
      ),
      true
    );
    assert.equal(values.includes(exomemContractFixture0490.digest), true);
    assert.equal(
      values.includes(
        `${exomemContractFixture0500.release}:${exomemContractFixture0500.protocol}`
      ),
      true
    );
    assert.equal(values.includes(exomemContractFixture0500.digest), true);
  });

  it("snapshots the exact 0.50.0 server-selected target when provision is enqueued", async () => {
    let statement = "";
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      statement = strings.join("?");
      values.push(...parameters);
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      new SqlLifecycleStore().enqueue(
        "018f2d91-7c42-7000-8000-000000000071",
        "provision",
        "target-snapshot"
      )
    );

    assert.match(statement, /target_candidate_id/i);
    assert.match(statement, /target_assignment_id/i);
    assert.match(statement, /target_assignment_generation/i);
    assert.match(statement, /target_gateway_contract_digest/i);
    assert.match(statement, /target_command_fingerprint/i);
    assert.match(statement, /target_schema_digest/i);
    assert.match(statement, /target_compatibility_digest/i);
    assert.match(statement, /state = 'preparing'/i);
    assert.match(statement, /state = 'live'/i);
    assert.match(statement, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    assert.equal(
      values.includes(
        `${exomemContractFixture0500.release}:${exomemContractFixture0500.protocol}`
      ),
      true
    );
    assert.equal(values.includes(exomemContractFixture0500.digest), true);
  });

  it("recovers a legacy v1 provision against the exact 0.49.0 target", async () => {
    const now = new Date();
    const operation = {
      id: "018f2d91-7c42-7000-8000-000000000081",
      tenant_id: "018f2d91-7c42-7000-8000-000000000071",
      cell_id: null,
      operation_type: "provision",
      provisioner_wire_protocol: "exomem-cell-provisioner.v1",
      state: "running",
      idempotency_key: "legacy-0490",
      fence_generation: 1,
      checkpoint: "created",
      request_id: "request-0490",
      attempts: 1,
      next_attempt_at: now,
      lease_owner: "worker-0490",
      lease_expires_at: new Date(now.valueOf() + 60_000),
      error_code: null,
      provider_result_ref: null,
      input_reference_ciphertext: null,
      input_reference_digest: null,
      input_export_id: null,
      export_release_reference_ciphertext: null,
      export_release_reference_digest: null,
      export_expires_at: null,
      export_request_started: false,
      input_source_cell_id: null,
      input_archive_sha256: null,
      input_manifest_sha256: null,
      input_archive_size: null,
      resume_after_operation: true,
      expected_previous_cell_id: null,
      target_candidate_id: null,
      target_assignment_id: null,
      target_assignment_generation: null,
      target_source_release: null,
      target_protocol_version: null,
      target_gateway_contract_digest: null,
      target_command_fingerprint: null,
      target_schema_digest: null,
      target_compatibility_digest: null,
      created_at: now,
      updated_at: now,
    };
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      const query = strings.join("?");
      values.push(...parameters);
      if (query.includes("lifecycle-claim")) return { rows: [operation] };
      if (query.includes("lifecycle-snapshot-legacy-target"))
        return {
          rows: [
            {
              ...operation,
              target_candidate_id: "018f2d91-7c42-7000-8000-000000000082",
              target_source_release: exomemContractFixture0490.release,
              target_protocol_version: exomemContractFixture0490.protocol,
              target_gateway_contract_digest: exomemContractFixture0490.digest,
              target_command_fingerprint: "a".repeat(64),
              target_schema_digest: "b".repeat(64),
              target_compatibility_digest: "c".repeat(64),
            },
          ],
        };
      return { rows: [] };
    });

    const claimed = await new SqlLifecycleStore().claim({
      owner: "worker-0490",
      leaseMs: 60_000,
      maxAttempts: 6,
    });

    assert.equal(claimed?.target?.sourceRelease, "0.49.0");
    assert.equal(claimed?.target?.gatewayContractDigest, exomemContractFixture0490.digest);
    assert.equal(
      values.includes(
        `${exomemContractFixture0490.release}:${exomemContractFixture0490.protocol}`
      ),
      true
    );
    assert.equal(values.includes(exomemContractFixture0490.digest), true);
  });

  it("derives a legacy routable v1 target against the exact 0.49.0 gateway contract", async () => {
    const now = new Date();
    const operation = {
      id: "018f2d91-7c42-7000-8000-000000000083",
      tenant_id: "018f2d91-7c42-7000-8000-000000000071",
      cell_id: "018f2d91-7c42-7000-8000-000000000084",
      operation_type: "provision",
      provisioner_wire_protocol: "exomem-cell-provisioner.v1",
      state: "running",
      idempotency_key: "legacy-routable-0490",
      fence_generation: 1,
      checkpoint: "created",
      request_id: "request-routable-0490",
      attempts: 1,
      next_attempt_at: now,
      lease_owner: "worker-routable-0490",
      lease_expires_at: new Date(now.valueOf() + 60_000),
      error_code: null,
      provider_result_ref: "provider-result",
      input_reference_ciphertext: null,
      input_reference_digest: null,
      input_export_id: null,
      export_release_reference_ciphertext: null,
      export_release_reference_digest: null,
      export_expires_at: null,
      export_request_started: false,
      input_source_cell_id: null,
      input_archive_sha256: null,
      input_manifest_sha256: null,
      input_archive_size: null,
      resume_after_operation: true,
      expected_previous_cell_id: null,
      target_candidate_id: null,
      target_assignment_id: null,
      target_assignment_generation: null,
      target_source_release: null,
      target_protocol_version: null,
      target_gateway_contract_digest: null,
      target_command_fingerprint: null,
      target_schema_digest: null,
      target_compatibility_digest: null,
      created_at: now,
      updated_at: now,
    };
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      const query = strings.join("?");
      values.push(...parameters);
      if (query.includes("lifecycle-claim")) return { rows: [operation] };
      if (query.includes("lifecycle-snapshot-legacy-target")) return { rows: [] };
      if (query.includes("lifecycle-legacy-deployment-gap")) {
        return { rows: [{ has_contract_catalog: true }] };
      }
      if (query.includes("lifecycle-derive-legacy-target-from-routable-cell")) {
        return {
          rows: [
            {
              ...operation,
              target_candidate_id: "018f2d91-7c42-7000-8000-000000000085",
              target_source_release: exomemContractFixture0490.release,
              target_protocol_version: exomemContractFixture0490.protocol,
              target_gateway_contract_digest: exomemContractFixture0490.digest,
              target_command_fingerprint: "a".repeat(64),
              target_schema_digest: "b".repeat(64),
              target_compatibility_digest: "c".repeat(64),
            },
          ],
        };
      }
      return { rows: [] };
    });

    const claimed = await new SqlLifecycleStore().claim({
      owner: "worker-routable-0490",
      leaseMs: 60_000,
      maxAttempts: 6,
    });

    assert.equal(claimed?.target?.sourceRelease, "0.49.0");
    assert.equal(claimed?.target?.gatewayContractDigest, exomemContractFixture0490.digest);
    assert.equal(
      values.includes(
        `${exomemContractFixture0490.release}:${exomemContractFixture0490.protocol}`
      ),
      true
    );
    assert.equal(values.includes(exomemContractFixture0490.digest), true);
  });

  it("persists the selected wire protocol with a catalog target for every cell-scoped operation", async () => {
    let statement = "";
    const values: unknown[] = [];
    __setExomemSqlForTests(async (strings, ...parameters) => {
      statement = strings.join("?");
      values.push(...parameters);
      return { rows: [], rowCount: 0 };
    });

    const previous = process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
    process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = " true ";
    try {
      await assert.rejects(
        new SqlLifecycleStore().enqueue(
          "018f2d91-7c42-7000-8000-000000000071",
          "seal",
          "v2-cell-target"
        )
      );
    } finally {
      if (previous === undefined) delete process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED;
      else process.env.EXOMEM_PROVISIONER_V2_ISSUANCE_ENABLED = previous;
    }

    assert.match(statement, /provisioner_wire_protocol/i);
    assert.equal(values.includes("exomem-cell-provisioner.v2"), true);
    assert.match(statement, /origin_target_identities AS MATERIALIZED/i);
    assert.match(statement, /legacy_cell_target_candidates AS MATERIALIZED/i);
    assert.match(statement, /tenant\.bound_cell_id/i);
    assert.match(statement, /operation\.target_source_release = bound_cell\.release_version/i);
    assert.match(statement, /operation\.target_protocol_version = bound_cell\.protocol_version/i);
    assert.match(statement, /candidate\.compatibility_digest = bound_cell\.observed_compatibility_digest/i);
    assert.match(statement, /JOIN target ON TRUE/i);
  });

  it("resolves a strict-v1 reviewer bind target for later maintenance and owner deletion", async () => {
    const statements: string[] = [];
    __setExomemSqlForTests(async (strings) => {
      statements.push(strings.join("?"));
      return { rows: [], rowCount: 0 };
    });

    await assert.rejects(
      new SqlLifecycleStore().enqueue(
        "018f2d91-7c42-7000-8000-000000000071",
        "suspend",
        "reviewer-v1-maintenance"
      )
    );
    await consumeDeletionConfirmationAtomic({
      userId: "018f2d91-7c42-7000-8000-000000000070",
      tenantId: "018f2d91-7c42-7000-8000-000000000071",
      tokenDigest: Buffer.alloc(32, 0x41),
    });

    for (const statement of statements) {
      const strictV1Target = statement.match(
        /strict_v1_reviewer_target AS MATERIALIZED \([\s\S]*?\),\s*origin_target_identities/i
      )?.[0];
      assert.ok(strictV1Target);
      assert.match(
        strictV1Target,
        /operation\.provisioner_wire_protocol = 'exomem-cell-provisioner\.v1'/i
      );
      assert.match(strictV1Target, /(?:tenant|tenant_gated)\.marketplace_reviewer_purpose = true/i);
      assert.match(strictV1Target, /assignment\.marketplace_reviewer_purpose = true/i);
      assert.match(strictV1Target, /assignment\.id = operation\.target_assignment_id/i);
      assert.doesNotMatch(strictV1Target, /assignment\.state = 'active'/i);
      assert.doesNotMatch(strictV1Target, /assignment\.expires_at > now\(\)/i);
      assert.doesNotMatch(strictV1Target, /candidate\.state IN \('pending', 'live'\)/i);
      assert.doesNotMatch(
        strictV1Target,
        /observed_gateway_contract_digest/i
      );
    }
  });

  it("attests every rollout lock under the cohort lock before it makes a replacement routable", async () => {
    const statements: string[] = [];
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        statements.push(strings.join("?"));
        return { rows: [], rowCount: 0 };
      })
    );

    assert.equal(
      await new SqlLifecycleStore().bindCandidate(
        "018f2d91-7c42-7000-8000-000000000070",
        "worker-a"
      ),
      false
    );

    const statement = statements.join("\n");
    assert.match(statement, /pg_advisory_xact_lock\(hashtext\('exomem-hosted-alpha-cohort'\)\)/i);
    assert.match(statement, /target_candidate_id/i);
    assert.match(statement, /target_assignment_id/i);
    assert.match(statement, /target_assignment_generation/i);
    assert.match(statement, /target_gateway_contract_digest/i);
    assert.match(statement, /target_command_fingerprint/i);
    assert.match(statement, /target_schema_digest/i);
    assert.match(statement, /target_compatibility_digest/i);
    assert.match(statement, /assignment\.state = 'preparing'/i);
    assert.match(statement, /assignment\.expires_at > now\(\)/i);
    assert.match(
      statement,
      /prior_observation_unrouted[\s\S]*EXISTS \(SELECT 1 FROM activated_assignment\)/i
    );
    assert.match(
      statement,
      /replacement_observation[\s\S]*EXISTS \(SELECT 1 FROM activated_assignment\)/i
    );
  });

  it("limits identity-less v1 binding to the exact marketplace reviewer assignment", async () => {
    const statements: string[] = [];
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        statements.push(strings.join("?"));
        return { rows: [], rowCount: 0 };
      })
    );

    await new SqlLifecycleStore().bindCandidate("018f2d91-7c42-7000-8000-000000000070", "worker-a");

    const statement = statements.join("\n");
    assert.match(
      statement,
      /operation\.provisioner_wire_protocol <> 'exomem-cell-provisioner\.v1'[\s\S]*candidate\.observed_gateway_contract_digest = operation\.target_gateway_contract_digest/i
    );
    assert.match(statement, /operation\.provisioner_wire_protocol = 'exomem-cell-provisioner\.v1'/i);
    assert.match(statement, /tenant\.marketplace_reviewer_purpose = true/i);
    assert.match(statement, /target_assignment\.marketplace_reviewer_purpose = true/i);
    assert.match(statement, /candidate\.observed_gateway_contract_digest IS NULL/i);
    assert.match(statement, /candidate\.observed_command_fingerprint IS NULL/i);
    assert.match(statement, /candidate\.observed_schema_digest IS NULL/i);
    assert.match(statement, /candidate\.observed_compatibility_digest IS NULL/i);
  });

  it("recognizes only the exact active assignment when a bind acknowledgement was lost", async () => {
    const statements: string[] = [];
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        statements.push(strings.join("?"));
        return { rows: [], rowCount: 0 };
      })
    );

    await new SqlLifecycleStore().bindCandidate("018f2d91-7c42-7000-8000-000000000070", "worker-a");

    const statement = statements.join("\n");
    assert.match(statement, /target_assignment\.state IN \('preparing', 'active'\)/i);
    assert.match(statement, /target_assignment\.expires_at > now\(\)/i);
    assert.match(statement, /already_bound AS \([\s\S]*routing_state = 'bound'/i);
    assert.match(statement, /retired AS \([\s\S]*EXISTS \(SELECT 1 FROM activated_assignment\)/i);
  });

  it("locks and revalidates the exact candidate state before making a target routable", async () => {
    const statements: string[] = [];
    __setExomemTransactionForTests(async (work) =>
      work(async (strings) => {
        statements.push(strings.join("?"));
        return { rows: [], rowCount: 0 };
      })
    );

    await new SqlLifecycleStore().bindCandidate("018f2d91-7c42-7000-8000-000000000070", "worker-a");

    const statement = statements.join("\n");
    assert.match(statement, /target_candidate_locked AS MATERIALIZED/i);
    assert.match(statement, /FOR UPDATE OF contract_candidate/i);
    assert.match(statement, /contract_candidate\.state = 'live'/i);
    assert.match(statement, /contract_candidate\.state IN \('pending', 'live'\)/i);
    assert.match(
      statement,
      /contract_candidate\.command_fingerprint = operation\.target_command_fingerprint/i
    );
  });
});
