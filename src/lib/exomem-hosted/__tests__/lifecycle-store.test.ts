import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { SqlLifecycleStore } from "../lifecycle-store";

afterEach(() => __setExomemSqlForTests(null));

describe("SQL lifecycle operation store", () => {
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
    __setExomemSqlForTests(async (strings) => {
      statement = strings.join("?");
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
  });
});
