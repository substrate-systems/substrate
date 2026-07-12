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
