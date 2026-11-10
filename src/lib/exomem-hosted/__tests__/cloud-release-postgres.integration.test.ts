import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";
import { Pool, type PoolClient } from "pg";
import { applyMigrations } from "../../../../scripts/migrate";
import { randomCloudCellId } from "../cloud-admission";
import {
  applyCloudReleaseChanges,
  clearPausedCloudRollout,
  CloudImageSeenError,
  CloudReleaseCellNotFoundError,
  CloudReleaseOlderError,
  getCloudOperatorView,
  getCloudRolloutView,
  InvalidCloudCellImageError,
  seedCloudImageHistory,
  setCloudCellDesiredImage,
} from "../cloud-release";
import { __setExomemSqlForTests, __setExomemTransactionForTests, type ExomemSql } from "../db";
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
const IMAGE_V3 = digestImage("3");

/** The owner sets the fleet image, as the admin token does through the route. */
function setImageAsAdmin(image: string, release = "v1.0.0"): Promise<void> {
  return applyCloudReleaseChanges({ cellImage: image, release }, "admin");
}

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

async function interactiveTransaction<T>(callback: (tx: ExomemSql) => Promise<T>): Promise<T> {
  const client = await pool!.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    const result = await callback(taggedSql(client));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function resetFleet(): Promise<void> {
  await pool!.query("DELETE FROM exomem_cloud_cells");
  await pool!.query("DELETE FROM exomem_tenants");
  await pool!.query("DELETE FROM exomem_users");
  await pool!.query("DELETE FROM users");
  await pool!.query("DELETE FROM exomem_cloud_capacity");
  await pool!.query("DELETE FROM exomem_cloud_settings");
  await pool!.query("DELETE FROM exomem_cloud_image_history");
  await pool!.query(
    "UPDATE exomem_cloud_rollout SET paused = false, error_code = NULL, held_cell_id = NULL, last_good_image = NULL WHERE id = 1"
  );
}

async function seedCell(desiredState = "running"): Promise<{ tenantId: string; cellId: string }> {
  const userResult = await pool!.query(
    "INSERT INTO exomem_users (email, email_verified_at) VALUES ($1, now()) RETURNING id",
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
    __setExomemTransactionForTests(interactiveTransaction);
  });

  after(async () => {
    __setExomemSqlForTests(null);
    __setExomemTransactionForTests(null);
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
    await setImageAsAdmin(IMAGE_V1);
    assert.equal((await getCloudOperatorView()).cellImage, IMAGE_V1);
    await setImageAsAdmin(IMAGE_V2);
    assert.equal((await getCloudOperatorView()).cellImage, IMAGE_V2);
  });

  // Security review finding 10: a tag, or an image from any repository other
  // than the configured one, is refused -- a tag can be repointed after the
  // fact, so accepting one would let the image a cell actually runs drift
  // silently out from under the operator's own release record.
  it("refuses a tag-based image, and an otherwise-valid digest on the wrong repository", async () => {
    await resetFleet();
    await assert.rejects(
      setImageAsAdmin("registry.example.test/exomem-cell:v1"),
      InvalidCloudCellImageError
    );
    await assert.rejects(
      setImageAsAdmin(`registry.example.test/some-other-image@sha256:${"1".repeat(64)}`),
      InvalidCloudCellImageError
    );
    // Not lowercase, not 64 characters: both rejected too.
    await assert.rejects(
      setImageAsAdmin(`${CELL_REPOSITORY}@sha256:${"A".repeat(64)}`),
      InvalidCloudCellImageError
    );
    await assert.rejects(
      setImageAsAdmin(`${CELL_REPOSITORY}@sha256:${"1".repeat(63)}`),
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
    await setImageAsAdmin(IMAGE_V1);

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

  // D5: a request that changes several values validates all of them before
  // writing any and writes them in one transaction, so a partly invalid
  // request changes nothing.
  it("applies a mixed release change atomically: all of it, or none of it", async () => {
    await resetFleet();
    const { cellId } = await seedCell();
    await setImageAsAdmin(IMAGE_V1);
    await pool!.query(
      "UPDATE exomem_cloud_rollout SET paused = true, error_code = 'PROBE_FAILED', held_cell_id = $1 WHERE id = 1",
      [cellId]
    );

    // A cell that does not exist: the fleet image and the pause stay as they were.
    await assert.rejects(
      applyCloudReleaseChanges(
        {
          cellImage: IMAGE_V2,
          release: "v2.0.0",
          clearRolloutPause: true,
          cellDesiredImage: { cellId: randomCloudCellId(), image: IMAGE_CANARY },
        },
        "admin"
      ),
      CloudReleaseCellNotFoundError
    );
    let view = await getCloudOperatorView();
    assert.equal(view.cellImage, IMAGE_V1);
    assert.equal(view.rollout?.paused, true);

    // An invalid override image is refused before anything is written.
    await assert.rejects(
      applyCloudReleaseChanges(
        {
          cellImage: IMAGE_V2,
          release: "v2.0.0",
          cellDesiredImage: { cellId, image: "registry.example.test/exomem-cell:canary" },
        },
        "admin"
      ),
      InvalidCloudCellImageError
    );
    view = await getCloudOperatorView();
    assert.equal(view.cellImage, IMAGE_V1);
    assert.equal(view.cells[0]?.desiredImage, null);

    // A fully valid request applies every part.
    await applyCloudReleaseChanges(
      {
        cellImage: IMAGE_V2,
        release: "v2.0.0",
        clearRolloutPause: true,
        cellDesiredImage: { cellId, image: IMAGE_CANARY },
      },
      "admin"
    );
    view = await getCloudOperatorView();
    assert.equal(view.cellImage, IMAGE_V2);
    assert.equal(view.rollout?.paused, false);
    assert.equal(view.cells[0]?.desiredImage, IMAGE_CANARY);
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
  // automate-cloud-releases D1: the image history and the deploy principal.

  async function cellImage(): Promise<string | null> {
    return (await getCloudOperatorView()).cellImage;
  }

  async function historyRows(): Promise<Array<Record<string, unknown>>> {
    const { rows } = await pool!.query(
      "SELECT image, release_tag, recorded_at FROM exomem_cloud_image_history ORDER BY image"
    );
    return rows;
  }

  it("refuses a deploy-token digest that was cell_image before, so a withdrawn release stays withdrawn", async () => {
    await resetFleet();
    await setImageAsAdmin(IMAGE_V1, "v1.0.0");
    await applyCloudReleaseChanges({ cellImage: IMAGE_V2, release: "v2.0.0" }, "deploy");
    // The owner withdraws release v2.0.0.
    await setImageAsAdmin(IMAGE_V1);

    await assert.rejects(
      applyCloudReleaseChanges({ cellImage: IMAGE_V2, release: "v2.0.0" }, "deploy"),
      CloudImageSeenError
    );
    assert.equal(await cellImage(), IMAGE_V1);

    // A newer release than the withdrawn one moves the fleet forward.
    await applyCloudReleaseChanges({ cellImage: IMAGE_V3, release: "v3.0.0" }, "deploy");
    assert.equal(await cellImage(), IMAGE_V3);
  });

  it("lets the admin token set an earlier digest", async () => {
    await resetFleet();
    await setImageAsAdmin(IMAGE_V1, "v1.0.0");
    await applyCloudReleaseChanges({ cellImage: IMAGE_V2, release: "v2.0.0" }, "deploy");
    await applyCloudReleaseChanges({ cellImage: IMAGE_V1 }, "admin");
    assert.equal(await cellImage(), IMAGE_V1);
  });

  it("refuses a deploy-token release older than the current cell_image's, writing nothing", async () => {
    await resetFleet();
    await setImageAsAdmin(IMAGE_V3, "v3.0.0");
    // v2.0.0 published but never became cell_image, e.g. while the platform gate held it.
    await assert.rejects(
      applyCloudReleaseChanges({ cellImage: IMAGE_V2, release: "v2.0.0" }, "deploy"),
      CloudReleaseOlderError
    );
    assert.equal(await cellImage(), IMAGE_V3);
    assert.deepEqual(
      (await historyRows()).map((row) => row.image),
      [IMAGE_V3]
    );
  });

  it("refuses, after the seed, a release digest published before the history shipped", async () => {
    await resetFleet();
    // The fleet as it stood before the history existed: v2.0.0 is live.
    await pool!.query(
      "INSERT INTO exomem_cloud_settings (key, value) VALUES ('cell_image', $1::jsonb)",
      [JSON.stringify(IMAGE_V2)]
    );
    await seedCloudImageHistory(
      [
        { release: "v1.0.0", image: IMAGE_V1 },
        { release: "v2.0.0", image: IMAGE_V2 },
      ],
      { commit: true }
    );

    await assert.rejects(
      applyCloudReleaseChanges({ cellImage: IMAGE_V1, release: "v1.0.0" }, "deploy"),
      CloudImageSeenError
    );
    assert.equal(await cellImage(), IMAGE_V2);
  });

  it("seeds live images with no tag, and a second seed adds no row and changes no tag", async () => {
    await resetFleet();
    const { cellId } = await seedCell();
    await pool!.query(
      "INSERT INTO exomem_cloud_settings (key, value) VALUES ('cell_image', $1::jsonb)",
      [JSON.stringify(IMAGE_V2)]
    );
    await pool!.query("UPDATE exomem_cloud_rollout SET last_good_image = $1 WHERE id = 1", [
      IMAGE_V1,
    ]);
    // An image no published release names: an owner's canary override.
    await pool!.query(
      "UPDATE exomem_cloud_cells SET observed_image = $1, desired_image = $2 WHERE cell_id = $3",
      [IMAGE_V2, IMAGE_CANARY, cellId]
    );
    const releases = [
      { release: "v2.0.0", image: IMAGE_V2 },
      { release: "v1.0.0", image: IMAGE_V1 },
    ];

    assert.deepEqual(await seedCloudImageHistory(releases, { commit: false }), {
      addedReleases: 2,
      addedLive: 1,
    });
    assert.deepEqual(await historyRows(), [], "a dry run wrote rows");

    await seedCloudImageHistory(releases, { commit: true });
    const seeded = await historyRows();
    assert.deepEqual(
      seeded.map((row) => [row.image, row.release_tag]),
      [
        [IMAGE_V1, "v1.0.0"],
        [IMAGE_V2, "v2.0.0"],
        [IMAGE_CANARY, null],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );

    // The second run also names the canary image as a release; its row keeps no tag.
    const again = await seedCloudImageHistory(
      [...releases, { release: "v9.0.0", image: IMAGE_CANARY }],
      { commit: true }
    );
    assert.deepEqual(again, { addedReleases: 0, addedLive: 0 });
    assert.deepEqual(await historyRows(), seeded);
  });

  it("checks only the history when the current cell_image has no tag", async () => {
    await resetFleet();
    // A seeded live image that matches no published release.
    await pool!.query(
      "INSERT INTO exomem_cloud_settings (key, value) VALUES ('cell_image', $1::jsonb)",
      [JSON.stringify(IMAGE_CANARY)]
    );
    await seedCloudImageHistory([], { commit: true });

    await assert.rejects(
      applyCloudReleaseChanges({ cellImage: IMAGE_CANARY, release: "v5.0.0" }, "deploy"),
      CloudImageSeenError
    );
    await applyCloudReleaseChanges({ cellImage: IMAGE_V1, release: "v0.0.1" }, "deploy");
    assert.equal(await cellImage(), IMAGE_V1);
  });

  it("reports the canary as not on target while a newer cell is Ready on it first", async () => {
    await resetFleet();
    await setImageAsAdmin(IMAGE_V1, "v1.0.0");
    await applyCloudReleaseChanges({ cellImage: IMAGE_V2, release: "v2.0.0" }, "deploy");
    const canary = await seedCell();
    const fresh = await seedCell();
    await pool!.query("UPDATE exomem_cloud_cells SET rollout_priority = 0 WHERE cell_id = $1", [
      canary.cellId,
    ]);
    await pool!.query(
      "UPDATE exomem_cloud_cells SET observed_image = $1, ready = true WHERE cell_id = $2",
      [IMAGE_V1, canary.cellId]
    );
    // A new cell provisions straight onto cell_image, which also sets last_good_image.
    await pool!.query(
      "UPDATE exomem_cloud_cells SET observed_image = $1, ready = true WHERE cell_id = $2",
      [IMAGE_V2, fresh.cellId]
    );
    await pool!.query("UPDATE exomem_cloud_rollout SET last_good_image = $1 WHERE id = 1", [
      IMAGE_V2,
    ]);

    let view = await getCloudRolloutView();
    assert.equal(view.canary_on_target, false);
    assert.deepEqual(view.cells, { on_target: 1, behind_target: 1, held: 0 });

    await pool!.query("UPDATE exomem_cloud_cells SET observed_image = $1 WHERE cell_id = $2", [
      IMAGE_V2,
      canary.cellId,
    ]);
    view = await getCloudRolloutView();
    assert.equal(view.canary_on_target, true);
    assert.equal(view.release, "v2.0.0");
  });

  it("keeps the rollout view free of cell and tenant IDs, and its size fixed as the fleet grows", async () => {
    await resetFleet();
    await setImageAsAdmin(IMAGE_V1, "v1.0.0");
    await pool!.query(
      "UPDATE exomem_cloud_rollout SET paused = true, error_code = 'PROBE_FAILED' WHERE id = 1"
    );
    const first = await seedCell();
    const small = JSON.stringify(await getCloudRolloutView());

    const more = [first];
    for (let index = 0; index < 5; index += 1) more.push(await seedCell());
    await pool!.query("UPDATE exomem_cloud_rollout SET held_cell_id = $1 WHERE id = 1", [
      first.cellId,
    ]);
    const large = JSON.stringify(await getCloudRolloutView());

    for (const { cellId, tenantId } of more) {
      assert.ok(!large.includes(cellId), "the view names a cell");
      assert.ok(!large.includes(tenantId), "the view names a tenant");
    }
    assert.equal(large.length, small.length);
    assert.deepEqual(JSON.parse(large), {
      cell_image: IMAGE_V1,
      release: "v1.0.0",
      paused: true,
      error_code: "PROBE_FAILED",
      canary_on_target: false,
      cells: { on_target: 0, behind_target: 6, held: 0 },
    });
  });
});
