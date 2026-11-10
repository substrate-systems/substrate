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
 *
 * `automate-cloud-releases` D1 adds the image history: every digest that was
 * ever `cell_image`, with its release tag. The only write to `cell_image`
 * records it there, and the deploy principal may set only a digest that the
 * history does not hold, with a release tag no older than the current one's.
 */

import { loadCloudCellImageRepository } from "./cloud-config";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";

const CELL_IMAGE_SETTINGS_KEY = "cell_image";
const CELL_IMAGE_DIGEST_HEX = /^[0-9a-f]{64}$/;
// The release workflow publishes only on tags of this form (vMAJOR.MINOR.PATCH);
// a format check that also yields the numbers the forward-only rule compares.
const RELEASE_TAG = /^v(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;

/** Who sends a release change: the owner's admin token, or the release automation's deploy token. */
export type CloudReleasePrincipal = "admin" | "deploy";

/** The tag is not `vMAJOR.MINOR.PATCH`, or a digest new to the history came without one. */
export class InvalidCloudReleaseTagError extends Error {
  constructor() {
    super("Exomem Cloud release tag must be vMAJOR.MINOR.PATCH, and a new image needs one");
    this.name = "InvalidCloudReleaseTagError";
  }
}

/** D1: the deploy principal sent a digest that was already `cell_image` once. */
export class CloudImageSeenError extends Error {
  readonly code = "CELL_IMAGE_SEEN";
  constructor() {
    super("this image was already the Cloud cell image");
    this.name = "CloudImageSeenError";
  }
}

/** D1: the deploy principal sent a release older than the current `cell_image`'s. */
export class CloudReleaseOlderError extends Error {
  readonly code = "CELL_RELEASE_OLDER";
  constructor() {
    super("this release is older than the current Cloud cell image");
    this.name = "CloudReleaseOlderError";
  }
}

function releaseVersion(tag: string): [number, number, number] | null {
  const match = RELEASE_TAG.exec(tag);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative when `a` is older than `b`. Both must be valid tags. */
function compareReleaseTags(a: string, b: string): number {
  const left = releaseVersion(a)!;
  const right = releaseVersion(b)!;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function assertValidCloudReleaseTag(tag: string): void {
  if (!releaseVersion(tag)) throw new InvalidCloudReleaseTagError();
}

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

/**
 * D1: sets the fleet-wide `cell_image` and records the digest in the image
 * history the first time it becomes `cell_image`. Runs inside the caller's
 * transaction, after `lockReleaseChanges`, so two concurrent changes cannot
 * both pass the checks against the same current image.
 */
async function writeReleaseImage(
  sql: ExomemSql,
  image: string,
  release: string | undefined,
  principal: CloudReleasePrincipal
): Promise<void> {
  const known = await sql`
    /* exomem-cloud:release-image-history */
    SELECT release_tag FROM exomem_cloud_image_history WHERE image = ${image}
  `;
  if (principal === "deploy") {
    if (known.rows.length > 0) throw new CloudImageSeenError();
    // The current image's tag. An untagged current image (seeded, matching no
    // published release) has nothing to compare, so only the history check applies.
    const current = await sql`
      /* exomem-cloud:release-current-tag */
      SELECT history.release_tag
      FROM exomem_cloud_settings settings
      JOIN exomem_cloud_image_history history ON history.image = settings.value #>> '{}'
      WHERE settings.key = ${CELL_IMAGE_SETTINGS_KEY}
    `;
    const currentTag = current.rows[0]?.release_tag;
    if (
      release !== undefined &&
      typeof currentTag === "string" &&
      releaseVersion(currentTag) &&
      compareReleaseTags(release, currentTag) < 0
    ) {
      throw new CloudReleaseOlderError();
    }
  }
  if (known.rows.length === 0) {
    if (release === undefined) throw new InvalidCloudReleaseTagError();
    await sql`
      /* exomem-cloud:record-release-image */
      INSERT INTO exomem_cloud_image_history (image, release_tag)
      VALUES (${image}, ${release})
      ON CONFLICT (image) DO NOTHING
    `;
  }
  await sql`
    /* exomem-cloud:set-release-image */
    INSERT INTO exomem_cloud_settings (key, value)
    VALUES (${CELL_IMAGE_SETTINGS_KEY}, ${JSON.stringify(image)}::jsonb)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
  `;
}

/** Serializes release changes on the rollout row, which every change already may update. */
async function lockReleaseChanges(sql: ExomemSql): Promise<void> {
  await sql`
    /* exomem-cloud:lock-release-changes */
    SELECT id FROM exomem_cloud_rollout WHERE id = 1 FOR UPDATE
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
  return writeClearPausedRollout(executeExomemSql);
}

async function writeClearPausedRollout(sql: ExomemSql): Promise<boolean> {
  const { rowCount } = await sql`
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
  return writeCellDesiredImage(executeExomemSql, cellId, image);
}

async function writeCellDesiredImage(
  sql: ExomemSql,
  cellId: string,
  image: string | null
): Promise<boolean> {
  const { rowCount } = await sql`
    /* exomem-cloud:set-cell-desired-image */
    UPDATE exomem_cloud_cells
    SET desired_image = ${image}
    WHERE cell_id = ${cellId} AND desired_state <> 'deleted'
  `;
  return (rowCount ?? 0) > 0;
}

/** The named cell has no non-deleted row; nothing in the request was applied. */
export class CloudReleaseCellNotFoundError extends Error {
  constructor() {
    super("Exomem Cloud cell not found");
    this.name = "CloudReleaseCellNotFoundError";
  }
}

export type CloudReleaseChanges = {
  cellImage?: string;
  /** `cellImage`'s release tag. Required for a digest new to the history. */
  release?: string;
  clearRolloutPause?: true;
  cellDesiredImage?: { cellId: string; image: string | null };
};

/**
 * D5: a request that changes several values validates all of them before
 * writing any, then writes them in one transaction, so a partly invalid
 * request -- a bad image, or a cell that does not exist -- changes nothing.
 * `principal` decides only the image history rule; the route refuses the
 * deploy principal every change but `cellImage` with its `release`.
 */
export async function applyCloudReleaseChanges(
  changes: CloudReleaseChanges,
  principal: CloudReleasePrincipal,
  dependencies: CloudCellImageValidationDependencies = {}
): Promise<void> {
  if (changes.cellImage !== undefined) assertValidCloudCellImage(changes.cellImage, dependencies);
  if (changes.release !== undefined) assertValidCloudReleaseTag(changes.release);
  const cellChange = changes.cellDesiredImage;
  if (cellChange && cellChange.image !== null) {
    assertValidCloudCellImage(cellChange.image, dependencies);
  }
  await withExomemTransaction(async (tx) => {
    await lockReleaseChanges(tx);
    if (changes.cellImage !== undefined) {
      await writeReleaseImage(tx, changes.cellImage, changes.release, principal);
    }
    if (changes.clearRolloutPause) await writeClearPausedRollout(tx);
    if (cellChange && !(await writeCellDesiredImage(tx, cellChange.cellId, cellChange.image))) {
      throw new CloudReleaseCellNotFoundError();
    }
  });
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

/**
 * `automate-cloud-releases` D1's rollout view: a fixed-size answer for the
 * release automation, whose logs are public. It holds no cell ID and no
 * tenant ID. The `cloud-deploy` workflow reads these names (spec
 * `cloud-release-automation`).
 */
export type CloudRolloutView = {
  cell_image: string | null;
  /** `cell_image`'s release tag; null for an image the history maps to no release. */
  release: string | null;
  paused: boolean;
  error_code: string | null;
  /**
   * The canary -- the non-deleted cell with the lowest rollout_priority, as
   * cellctl chooses it -- reports its target image as observed, and Ready.
   * False when there is no cell.
   */
  canary_on_target: boolean;
  /** Running and read-only cells, by whether their observed image is their target; and cells under a hold. */
  cells: { on_target: number; behind_target: number; held: number };
};

/**
 * One aggregate statement over the non-deleted cells. A cell's target is its
 * desired_image, or else cell_image, as cellctl's rollout computes it.
 */
export async function getCloudRolloutView(): Promise<CloudRolloutView> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:rollout-view */
    WITH settings AS (
      SELECT value #>> '{}' AS cell_image
      FROM exomem_cloud_settings
      WHERE key = ${CELL_IMAGE_SETTINGS_KEY}
    ),
    live AS (
      SELECT cells.cell_id, cells.rollout_priority, cells.desired_state, cells.observed_image,
             cells.ready, cells.hold_kind,
             COALESCE(cells.desired_image, (SELECT cell_image FROM settings)) AS target
      FROM exomem_cloud_cells cells
      WHERE cells.desired_state <> 'deleted'
    ),
    canary AS (
      SELECT observed_image, ready, target FROM live ORDER BY rollout_priority, cell_id LIMIT 1
    )
    SELECT
      (SELECT cell_image FROM settings) AS cell_image,
      (SELECT history.release_tag FROM exomem_cloud_image_history history
         WHERE history.image = (SELECT cell_image FROM settings)) AS release,
      rollout.paused,
      rollout.error_code,
      COALESCE((SELECT observed_image = target AND ready FROM canary), false) AS canary_on_target,
      (SELECT count(*) FROM live
         WHERE desired_state IN ('running', 'read_only') AND observed_image = target) AS on_target,
      (SELECT count(*) FROM live
         WHERE desired_state IN ('running', 'read_only') AND target IS NOT NULL
           AND observed_image IS DISTINCT FROM target) AS behind_target,
      (SELECT count(*) FROM live WHERE hold_kind IS NOT NULL) AS held
    FROM exomem_cloud_rollout rollout
    WHERE rollout.id = 1
  `;
  const row = rows[0];
  if (!row) throw new Error("exomem_cloud_rollout has no row");
  return {
    cell_image: row.cell_image === null ? null : String(row.cell_image),
    release: row.release === null || row.release === undefined ? null : String(row.release),
    paused: row.paused === true,
    error_code: row.error_code === null ? null : String(row.error_code),
    canary_on_target: row.canary_on_target === true,
    cells: {
      on_target: Number(row.on_target),
      behind_target: Number(row.behind_target),
      held: Number(row.held),
    },
  };
}

/** One published release's cell image, as the release workflow published it. */
export type PublishedCloudRelease = { release: string; image: string };

export type CloudImageHistorySeed = {
  /** Rows this run added from the published releases. */
  addedReleases: number;
  /** Rows this run added from the live Cloud tables, without a tag. */
  addedLive: number;
};

class SeedDryRun extends Error {
  constructor(readonly result: CloudImageHistorySeed) {
    super("dry run");
  }
}

/**
 * D1's seed, before the deploy principal can use the history: every
 * published release's cell image with its tag, then every image the live
 * Cloud tables name -- `cell_image`, `last_good_image`, and each cell's
 * observed and desired image -- without one, so the history holds every
 * digest that was ever `cell_image`. It only adds rows, so a second run
 * changes nothing. Releases go first, so a live image that a release
 * published keeps that release's tag; when two tags name one image, the
 * oldest keeps it. A dry run reports the counts and rolls back.
 */
export async function seedCloudImageHistory(
  releases: readonly PublishedCloudRelease[],
  options: { commit: boolean },
  dependencies: CloudCellImageValidationDependencies = {}
): Promise<CloudImageHistorySeed> {
  for (const { release, image } of releases) {
    assertValidCloudReleaseTag(release);
    assertValidCloudCellImage(image, dependencies);
  }
  const tagByImage = new Map<string, string>();
  for (const { release, image } of [...releases].sort((a, b) =>
    compareReleaseTags(a.release, b.release)
  )) {
    if (!tagByImage.has(image)) tagByImage.set(image, release);
  }
  try {
    return await withExomemTransaction(async (tx) => {
      await lockReleaseChanges(tx);
      const fromReleases = await tx`
        /* exomem-cloud:seed-image-history-releases */
        INSERT INTO exomem_cloud_image_history (image, release_tag)
        SELECT image, release_tag
        FROM unnest(${[...tagByImage.keys()]}::text[], ${[...tagByImage.values()]}::text[])
          AS published(image, release_tag)
        ON CONFLICT (image) DO NOTHING
      `;
      const fromLive = await tx`
        /* exomem-cloud:seed-image-history-live */
        INSERT INTO exomem_cloud_image_history (image)
        SELECT image FROM (
          SELECT value #>> '{}' AS image FROM exomem_cloud_settings
            WHERE key = ${CELL_IMAGE_SETTINGS_KEY}
          UNION SELECT last_good_image FROM exomem_cloud_rollout
          UNION SELECT observed_image FROM exomem_cloud_cells
          UNION SELECT desired_image FROM exomem_cloud_cells
        ) live
        WHERE image IS NOT NULL
        ON CONFLICT (image) DO NOTHING
      `;
      const result = {
        addedReleases: fromReleases.rowCount ?? 0,
        addedLive: fromLive.rowCount ?? 0,
      };
      if (!options.commit) throw new SeedDryRun(result);
      return result;
    });
  } catch (error) {
    if (error instanceof SeedDryRun) return error.result;
    throw error;
  }
}
