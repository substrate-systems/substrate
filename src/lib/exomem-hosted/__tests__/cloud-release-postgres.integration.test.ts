import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import {
  clearPausedCloudRollout,
  getCloudOperatorView,
  InvalidCloudCellImageError,
  setCloudCellDesiredImage,
  setCloudReleaseImage,
} from "../cloud-release";
import { __setExomemSqlForTests, type ExomemSql } from "../db";
import { ensureExomemPostgresTestExtensions } from "./postgres-test-extensions";

// Task 3.8: the owner-only release route's data layer (design D5) against
// real PostgreSQL.

// Security review finding 10: every image fixture here is
// <configured repository>@sha256:<64 lowercase hex> -- setCloudReleaseImage
// and setCloudCellDesiredImage both refuse anything else, including the
// tag-based images (":v1", ":canary", ...) this file used before the fix.
const CELL_REPOSITORY = "registry.example.test/exomem-cell";
function digestImage(fill: string): string {
  return `${CELL_REPOSITORY}@sha256:${fill.repeat(64).slice(0, 64)}`;
}
const IMAGE_V1 = digestImage("1");
const IMAGE_V2 = digestImage("2");
const IMAGE_CANARY = digestImage("c");
const IMAGE_V9 = digestImage("9");

const databaseUrl = process.env.EXOMEM_TEST_DATABASE_URL;
let pool: Pool | undefined;
let schema: string | undefined;
let priorRepositoryEnv: string | undefined;

function taggedSql(client: Pool | PoolClient): ExomemSql {
  return async (strings, ...values) => {
    let text = strings[0];
    for (let index = 0; index < values.length; index += 1) {
      text += `$${index + 1}${strings[index + 1]}`;
    }
    const result = await client.query(text, values);
    return { rows: result.rows as Array<Record<string, unknown>>, rowCount: result.rowCount ?? 0 };
  };
}

async function resetFleet(): Promise<void> {
  await pool!.query("DELETE FROM exomem_cloud_cells");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM users");
  await pool!.query("DELETE FROM exomem_cloud_capacity");
  await pool!.query("DELETE FROM exomem_cloud_settings");
  await pool!.query(
    "UPDATE exomem_cloud_rollout SET paused = false, error_code = NULL, held_cell_id = NULL, last_good_image = NULL WHERE id = 1"
  );
}

async function seedCell(desiredState = "running"): Promise<{ tenantId: string; cellId: string }> {
  const userResult = await pool!.query(
    "INSERT INTO users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
    [`cloud-release-${randomUUID()}@example.test`]
  );
  const tenantResult = await pool!.query(
    "INSERT INTO exomem_tenants (owner_user_id) VALUES ($1) RETURNING id",
    [userResult.rows[0].id]
  );
  const tenantId = tenantResult.rows[0].id as string;
  const cellId = randomCloudCellId();
  await pool!.query(
    "INSERT INTO exomem_cloud_cells (cell_id, tenant_id, desired_state) VALUES ($1, $2, $3)",
    [cellId, tenantId, desiredState]
  );
  return { tenantId, cellId };
}

describe("Exomem Cloud release control PostgreSQL integration", { skip: !databaseUrl }, () => {
  before(async () => {
    priorRepositoryEnv = process.env.EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY;
    process.env.EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY = CELL_REPOSITORY;
    schema = `cloud_release_it_${randomUUID().replaceAll("-", "")}`;
    await ensureExomemPostgresTestExtensions(databaseUrl!);
    const admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    await applyMigrations({ databaseUrl: scoped.toString() });
    await admin.end();
    pool = new Pool({ connectionString: scoped.toString() });
    __setExomemSqlForTests(taggedSql(pool));
  });

  after(async () => {
    __setExomemSqlForTests(null);
    if (pool) await pool.end();
    if (schema) {
      const admin = new Pool({ connectionString: databaseUrl });
      await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end();
    }
    if (priorRepositoryEnv === undefined) delete process.env.EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY;
    else process.env.EXOMEM_CLOUD_CELL_IMAGE_REPOSITORY = priorRepositoryEnv;
  });

  it("sets and overwrites the fleet release image", async () => {
    await resetFleet();
    await setCloudReleaseImage(IMAGE_V1);
    assert.equal((await getCloudOperatorView()).cellImage, IMAGE_V1);
    await setCloudReleaseImage(IMAGE_V2);
    assert.equal((await getCloudOperatorView()).cellImage, IMAGE_V2);
  });

  // Security review finding 10: a tag, or an image from any repository other
  // than the configured one, is refused -- a tag can be repointed after the
  // fact, so accepting one would let the image a cell actually runs drift
  // silently out from under the operator's own release record.
  it("refuses a tag-based image, and an otherwise-valid digest on the wrong repository", async () => {
    await resetFleet();
    await assert.rejects(
      setCloudReleaseImage("registry.example.test/exomem-cell:v1"),
      InvalidCloudCellImageError
    );
    await assert.rejects(
      setCloudReleaseImage(`registry.example.test/some-other-image@sha256:${"1".repeat(64)}`),
      InvalidCloudCellImageError
    );
    // Not lowercase, not 64 characters: both rejected too.
    await assert.rejects(
      setCloudReleaseImage(`${CELL_REPOSITORY}@sha256:${"A".repeat(64)}`),
      InvalidCloudCellImageError
    );
    await assert.rejects(
      setCloudReleaseImage(`${CELL_REPOSITORY}@sha256:${"1".repeat(63)}`),
      InvalidCloudCellImageError
    );
    assert.equal((await getCloudOperatorView()).cellImage, null);
  });

  it("clears a paused rollout, dropping its error code and held cell", async () => {
    await resetFleet();
    const { cellId } = await seedCell();
    await pool!.query(
      "UPDATE exomem_cloud_rollout SET paused = true, error_code = 'PROBE_FAILED', held_cell_id = $1 WHERE id = 1",
      [cellId]
    );
    const cleared = await clearPausedCloudRollout();
    assert.equal(cleared, true);
    const view = await getCloudOperatorView();
    assert.deepEqual(view.rollout?.paused, false);
    assert.equal(view.rollout?.errorCode, null);
    assert.equal(view.rollout?.heldCellId, null);
  });

  it("does nothing when the rollout is not paused", async () => {
    await resetFleet();
    const cleared = await clearPausedCloudRollout();
    assert.equal(cleared, false);
  });

  it("sets and clears one cell's desired_image override independent of the fleet image", async () => {
    await resetFleet();
    const { cellId } = await seedCell();
    await setCloudReleaseImage(IMAGE_V1);

    const applied = await setCloudCellDesiredImage(cellId, IMAGE_CANARY);
    assert.equal(applied, true);
    let view = await getCloudOperatorView();
    assert.equal(view.cells[0]?.desiredImage, IMAGE_CANARY);
    assert.equal(view.cellImage, IMAGE_V1);

    await setCloudCellDesiredImage(cellId, null);
    view = await getCloudOperatorView();
    assert.equal(view.cells[0]?.desiredImage, null);
  });

  it("refuses a tag-based desired_image override the same way", async () => {
    await resetFleet();
    const { cellId } = await seedCell();
    await assert.rejects(
      setCloudCellDesiredImage(cellId, "registry.example.test/exomem-cell:canary"),
      InvalidCloudCellImageError
    );
    const view = await getCloudOperatorView();
    assert.equal(view.cells[0]?.desiredImage, null);
  });

  it("refuses to set desired_image on an already-deleted cell", async () => {
    await resetFleet();
    const { cellId } = await seedCell("deleted");
    const applied = await setCloudCellDesiredImage(cellId, IMAGE_V9);
    assert.equal(applied, false);
  });

  it("reports observed cell state, rollout state and capacity together", async () => {
    await resetFleet();
    const { cellId, tenantId } = await seedCell();
    await pool!.query(
      `UPDATE exomem_cloud_cells
       SET observed_state = 'running', observed_image = 'registry.example.test/exomem-cell:v1',
           ready = true, node = 'node-a', observed_at = now()
       WHERE cell_id = $1`,
      [cellId]
    );
    await pool!.query(
      "INSERT INTO exomem_cloud_capacity (node, cell_slots, attachments_used, observed_at) VALUES ('node-a', 4, 1, now())"
    );

    const view = await getCloudOperatorView();
    const cell = view.cells.find((c) => c.cellId === cellId);
    assert.ok(cell);
    assert.equal(cell!.tenantId, tenantId);
    assert.equal(cell!.observedState, "running");
    assert.equal(cell!.observedImage, "registry.example.test/exomem-cell:v1");
    assert.equal(cell!.ready, true);
    assert.equal(cell!.node, "node-a");
    assert.equal(view.capacity.length, 1);
    assert.equal(view.capacity[0]!.node, "node-a");
    assert.equal(view.capacity[0]!.cellSlots, 4);
    assert.equal(view.capacity[0]!.attachmentsUsed, 1);
  });

  it("excludes deleted cells from the operator view", async () => {
    await resetFleet();
    await seedCell("deleted");
    const view = await getCloudOperatorView();
    assert.equal(view.cells.length, 0);
  });
});
