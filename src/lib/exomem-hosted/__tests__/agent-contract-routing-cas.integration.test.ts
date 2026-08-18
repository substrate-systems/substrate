import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import {
  __setExomemSqlForTests,
  __setExomemTransactionForTests,
  type ExomemSql,
  type ExomemTransaction,
} from "../db";
import { exomemHostedContractFixture } from "../agent-contract-fixture";
import { promoteExomemHostedCohort, recordRoutableCellObservation } from "../agent-contract-store";
import { SqlLifecycleStore } from "../lifecycle-store";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;

function sql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1)
      text += `$${index + 1}${strings[index + 1]}`;
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

function transactionSql(client: PoolClient): ExomemSql & ExomemTransaction {
  const tagged = sql(client) as ExomemSql & ExomemTransaction;
  tagged.query = async (text, values = []) => {
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
  return tagged;
}

async function transaction<T>(work: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN");
    const result = await work(transactionSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createCell(): Promise<string> {
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`routing-cas-${randomUUID()}@example.test`]
  );
  const tenant = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_tenants (owner_user_id, status, desired_state)
     VALUES ($1, 'active', 'running') RETURNING id`,
    [user.rows[0]!.id]
  );
  const cell = await pool!.query<{ id: string }>(
    `INSERT INTO exomem_cells (
       tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
     ) VALUES ($1, 'active', 'bound', 'running', '1', '0.34.0') RETURNING id`,
    [tenant.rows[0]!.id]
  );
  await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
    cell.rows[0]!.id,
    tenant.rows[0]!.id,
  ]);
  return cell.rows[0]!.id;
}

/**
 * A bound cell plus the capacity allocation and running, leased delete operation
 * that `markCellState` requires, so the destroy can actually complete.
 */
async function createDestroyableCell(): Promise<{ cellId: string; operationId: string }> {
  const user = await pool!.query<{ id: string }>(
    "INSERT INTO users (email) VALUES ($1) RETURNING id",
    [`routing-cas-destroy-${randomUUID()}@example.test`]
  );
  const tenantId = (
    await pool!.query<{ id: string }>(
      `INSERT INTO exomem_tenants (owner_user_id, status, desired_state, fence_generation)
       VALUES ($1, 'active', 'running', 1) RETURNING id`,
      [user.rows[0]!.id]
    )
  ).rows[0]!.id;
  const cellId = (
    await pool!.query<{ id: string }>(
      `INSERT INTO exomem_cells (
         tenant_id, lifecycle_state, routing_state, desired_state, protocol_version, release_version
       ) VALUES ($1, 'active', 'bound', 'running', '1', '0.34.0') RETURNING id`,
      [tenantId]
    )
  ).rows[0]!.id;
  await pool!.query("UPDATE exomem_tenants SET bound_cell_id = $1 WHERE id = $2", [
    cellId,
    tenantId,
  ]);
  const operationId = (
    await pool!.query<{ id: string }>(
      `INSERT INTO exomem_lifecycle_operations (
         tenant_id, cell_id, operation_type, state, idempotency_key, fence_generation,
         checkpoint, lease_owner, lease_expires_at
       ) VALUES ($1, $2, 'delete', 'running', $3, 1, 'cell-draining', 'worker-destroy',
                 now() + interval '1 hour')
       RETURNING id`,
      [tenantId, cellId, randomUUID()]
    )
  ).rows[0]!.id;
  const poolRow = await pool!.query<{ id: string }>(
    "SELECT id FROM exomem_capacity_pools WHERE pool_key = 'exomem-hosted-alpha'"
  );
  await pool!.query(
    `INSERT INTO exomem_capacity_allocations (
       pool_id, tenant_id, storage_bytes, runtime_slots, provision_slots, state
     ) VALUES ($1, $2, 5, 1, 0, 'occupied')`,
    [poolRow.rows[0]!.id, tenantId]
  );
  // The release transition subtracts this allocation from the pool, so the pool
  // must actually be carrying it or the transition is rejected.
  await pool!.query(
    `UPDATE exomem_capacity_pools
     SET reserved_storage_bytes = reserved_storage_bytes + 5,
         reserved_runtime_slots = reserved_runtime_slots + 1
     WHERE id = $1`,
    [poolRow.rows[0]!.id]
  );
  return { cellId, operationId };
}

describe("agent contract routable-set CAS", { skip: !databaseUrl }, () => {
  before(async () => {
    schema = `agent_contract_routing_cas_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(sql(pool));
    __setExomemTransactionForTests(transaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
    await pool?.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
  });

  it("rejects a stale digest after a same-release routable cell swap", async () => {
    const [firstCellId, secondCellId, replacementCellId] = await Promise.all([
      createCell(),
      createCell(),
      createCell(),
    ]);
    const fixture = exomemHostedContractFixture.compatibility;
    const observation = {
      sourceRelease: exomemHostedContractFixture.sourceRelease,
      protocolVersion: fixture.agent_contract.protocol_version,
      commandSurfaceSha256: fixture.command_surface_sha256,
      schemaDigest: fixture.schema_contract_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      routable: true,
    };
    await recordRoutableCellObservation({ ...observation, cellId: firstCellId });
    await recordRoutableCellObservation({ ...observation, cellId: secondCellId });
    const stale = await pool!.query<{ routable_set_digest: string }>(
      "SELECT routable_set_digest FROM exomem_agent_contract_profile_authority WHERE profile_id = $1",
      [fixture.profile]
    );
    const staleDigest = stale.rows[0]!.routable_set_digest;

    await pool!.query(
      "UPDATE exomem_routable_cell_contracts SET routable = false WHERE cell_id = $1 AND profile_id = $2",
      [firstCellId, fixture.profile]
    );
    await pool!.query(
      `INSERT INTO exomem_routable_cell_contracts (
         cell_id, profile_id, source_release, protocol_version, command_fingerprint,
         contract_digest, compatibility_digest, routable
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, true)`,
      [
        replacementCellId,
        fixture.profile,
        observation.sourceRelease,
        observation.protocolVersion,
        observation.commandSurfaceSha256,
        observation.schemaDigest,
        observation.compatibilitySha256,
      ]
    );
    const freshDigest = createHash("sha256")
      .update(
        [secondCellId, replacementCellId]
          .sort()
          .map((cellId) =>
            JSON.stringify([
              fixture.profile,
              cellId,
              observation.sourceRelease,
              observation.protocolVersion,
              observation.commandSurfaceSha256,
              observation.schemaDigest,
              observation.compatibilitySha256,
            ])
          )
          .join(",")
      )
      .digest("hex");
    assert.notEqual(freshDigest, staleDigest);

    assert.equal(
      await promoteExomemHostedCohort({
        candidateId: randomUUID(),
        claudeArtifactId: randomUUID(),
        openaiArtifactId: randomUUID(),
        expectedLiveCandidateId: null,
        expectedRoutableCellDigest: staleDigest,
        claudeEvidence: {},
        openaiEvidence: {},
      }),
      "precondition_failed"
    );
  });
  it("clears the routable observation when a cell is destroyed", async () => {
    const { cellId, operationId } = await createDestroyableCell();
    const fixture = exomemHostedContractFixture.compatibility;
    await recordRoutableCellObservation({
      cellId,
      sourceRelease: exomemHostedContractFixture.sourceRelease,
      protocolVersion: fixture.agent_contract.protocol_version,
      commandSurfaceSha256: fixture.command_surface_sha256,
      schemaDigest: fixture.schema_contract_sha256,
      compatibilitySha256: fixture.compatibility_sha256,
      routable: true,
    });
    assert.equal(
      (
        await pool!.query(
          "SELECT 1 FROM exomem_routable_cell_contracts WHERE cell_id = $1 AND routable",
          [cellId]
        )
      ).rowCount,
      1,
      "the cell is routable before it is destroyed"
    );

    assert.equal(
      await new SqlLifecycleStore().markCellState(operationId, "worker-destroy", "deleted"),
      true
    );

    // The row is kept but no longer routable. Promotion live-probes every
    // routable row, so a destroyed cell left routable is a ghost that fails the
    // probe and blocks all future promotions.
    assert.deepEqual(
      (
        await pool!.query<{ routable: boolean }>(
          "SELECT routable FROM exomem_routable_cell_contracts WHERE cell_id = $1",
          [cellId]
        )
      ).rows,
      [{ routable: false }],
      "destroying the tenant clears the routable flag on its cell"
    );
  });
});
