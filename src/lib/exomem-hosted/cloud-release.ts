/**
 * Exomem Cloud owner release control (design D5, `adopt-exomem-cloud-plain-cells`).
 *
 * Additive and gated: nothing here is called from any hosted code path, and
 * this module writes only the three columns D5 names — `exomem_cloud_settings
 * .cell_image`, a paused `exomem_cloud_rollout`, and one cell's
 * `desired_image` — matching exactly the grants `substrate_app` holds in
 * `scripts/exomem-cloud-grants.sql`. It never touches `desired_state`; that
 * remains admission's (cloud-admission.ts) and lifecycle reconciliation's
 * (cloud-lifecycle.ts) concern.
 */

import { loadCloudCellImageRepository } from "./cloud-config";
import { executeExomemSql } from "./db";

const CELL_IMAGE_SETTINGS_KEY = "cell_image";
const CELL_IMAGE_DIGEST_HEX = /^[0-9a-f]{64}$/;

export class InvalidCloudCellImageError extends Error {
  constructor(readonly image: string) {
    super(
      "Exomem Cloud cell image must be exactly <configured cell repository>@sha256:<64 lowercase hex>"
    );
    this.name = "InvalidCloudCellImageError";
  }
}

export type CloudCellImageValidationDependencies = {
  loadRepository?: typeof loadCloudCellImageRepository;
};

/**
 * Security review finding 10: `cell_image` and a cell's `desired_image`
 * override accept only the configured repository pinned to a sha256 digest
 * -- never a mutable tag. Called from both setters below, so nothing can
 * write a tag-based image through this module regardless of entry point;
 * exported so a caller that wants to validate ahead of the write (e.g. the
 * admin route, to answer with 400 rather than surface this error as an
 * internal one) can reuse the exact same check.
 */
export function assertValidCloudCellImage(
  image: string,
  dependencies: CloudCellImageValidationDependencies = {}
): void {
  const repository = (dependencies.loadRepository ?? loadCloudCellImageRepository)();
  const prefix = `${repository}@sha256:`;
  const digest = image.startsWith(prefix) ? image.slice(prefix.length) : null;
  if (!digest || !CELL_IMAGE_DIGEST_HEX.test(digest)) {
    throw new InvalidCloudCellImageError(image);
  }
}

/** Sets the fleet-wide default image new/reconciled cells roll out to. */
export async function setCloudReleaseImage(
  image: string,
  dependencies: CloudCellImageValidationDependencies = {}
): Promise<void> {
  assertValidCloudCellImage(image, dependencies);
  await executeExomemSql`
    /* exomem-cloud:set-release-image */
    INSERT INTO exomem_cloud_settings (key, value)
    VALUES (${CELL_IMAGE_SETTINGS_KEY}, ${JSON.stringify(image)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/**
 * Clears a paused rollout: unpauses it and drops the error code and held
 * cell. Only ever touches the row when it is actually paused, mirroring the
 * "clear a paused rollout" release action rather than an unconditional reset
 * — a rollout that was never paused has nothing here for the owner to clear.
 * Returns whether a paused row was found and cleared.
 */
export async function clearPausedCloudRollout(): Promise<boolean> {
  const { rowCount } = await executeExomemSql`
    /* exomem-cloud:clear-paused-rollout */
    UPDATE exomem_cloud_rollout
    SET paused = false, error_code = NULL, held_cell_id = NULL
    WHERE id = 1 AND paused = true
  `;
  return (rowCount ?? 0) > 0;
}

/**
 * Sets or clears (`image = null`) one cell's `desired_image` override, e.g.
 * to canary a release on a single cell ahead of the fleet-wide setting, or
 * to drop that override back to the fleet default. Never touches a
 * `deleted` cell.
 */
export async function setCloudCellDesiredImage(
  cellId: string,
  image: string | null,
  dependencies: CloudCellImageValidationDependencies = {}
): Promise<boolean> {
  if (image !== null) assertValidCloudCellImage(image, dependencies);
  const { rowCount } = await executeExomemSql`
    /* exomem-cloud:set-cell-desired-image */
    UPDATE exomem_cloud_cells
    SET desired_image = ${image}
    WHERE cell_id = ${cellId} AND desired_state <> 'deleted'
  `;
  return (rowCount ?? 0) > 0;
}

export type CloudOperatorCellView = {
  cellId: string;
  tenantId: string;
  desiredState: string;
  desiredImage: string | null;
  generation: number;
  observedState: string | null;
  observedImage: string | null;
  ready: boolean;
  lastErrorCode: string | null;
  observedAt: string | null;
  node: string | null;
};

export type CloudOperatorRolloutView = {
  paused: boolean;
  errorCode: string | null;
  heldCellId: string | null;
  lastGoodImage: string | null;
  updatedAt: string;
};

export type CloudOperatorCapacityView = {
  node: string;
  cellSlots: number;
  attachmentsUsed: number;
  observedAt: string | null;
};

export type CloudOperatorView = {
  cellImage: string | null;
  rollout: CloudOperatorRolloutView | null;
  cells: CloudOperatorCellView[];
  capacity: CloudOperatorCapacityView[];
};

/**
 * The operator view D5 asks for: the configured release image, rollout
 * state, every non-deleted cell's observed state, and capacity. Read-only —
 * SELECT is all this needs, and `substrate_app` already holds it on all four
 * Cloud tables.
 */
export async function getCloudOperatorView(): Promise<CloudOperatorView> {
  const [settingsResult, rolloutResult, cellsResult, capacityResult] = await Promise.all([
    executeExomemSql`
      /* exomem-cloud:operator-view-settings */
      SELECT value FROM exomem_cloud_settings WHERE key = ${CELL_IMAGE_SETTINGS_KEY}
    `,
    executeExomemSql`
      /* exomem-cloud:operator-view-rollout */
      SELECT paused, error_code, held_cell_id, last_good_image, updated_at
      FROM exomem_cloud_rollout
      WHERE id = 1
    `,
    executeExomemSql`
      /* exomem-cloud:operator-view-cells */
      SELECT cell_id, tenant_id, desired_state, desired_image, generation,
             observed_state, observed_image, ready, last_error_code, observed_at, node
      FROM exomem_cloud_cells
      WHERE desired_state <> 'deleted'
      ORDER BY created_at
    `,
    executeExomemSql`
      /* exomem-cloud:operator-view-capacity */
      SELECT node, cell_slots, attachments_used, observed_at
      FROM exomem_cloud_capacity
      ORDER BY node
    `,
  ]);

  const settingsRow = settingsResult.rows[0] as { value: unknown } | undefined;
  const rolloutRow = rolloutResult.rows[0] as
    | {
        paused: boolean;
        error_code: string | null;
        held_cell_id: string | null;
        last_good_image: string | null;
        updated_at: string;
      }
    | undefined;

  return {
    cellImage: settingsRow ? (settingsRow.value as string) : null,
    rollout: rolloutRow
      ? {
          paused: rolloutRow.paused,
          errorCode: rolloutRow.error_code,
          heldCellId: rolloutRow.held_cell_id,
          lastGoodImage: rolloutRow.last_good_image,
          updatedAt: new Date(rolloutRow.updated_at).toISOString(),
        }
      : null,
    cells: cellsResult.rows.map((row) => ({
      cellId: String(row.cell_id),
      tenantId: String(row.tenant_id),
      desiredState: String(row.desired_state),
      desiredImage: row.desired_image === null ? null : String(row.desired_image),
      generation: Number(row.generation),
      observedState: row.observed_state === null ? null : String(row.observed_state),
      observedImage: row.observed_image === null ? null : String(row.observed_image),
      ready: Boolean(row.ready),
      lastErrorCode: row.last_error_code === null ? null : String(row.last_error_code),
      observedAt: row.observed_at === null ? null : new Date(row.observed_at as string).toISOString(),
      node: row.node === null ? null : String(row.node),
    })),
    capacity: capacityResult.rows.map((row) => ({
      node: String(row.node),
      cellSlots: Number(row.cell_slots),
      attachmentsUsed: Number(row.attachments_used),
      observedAt: row.observed_at === null ? null : new Date(row.observed_at as string).toISOString(),
    })),
  };
}
