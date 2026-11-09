/**
 * Signed deletion grants (Exomem `automate-cell-storage-deletion`, D1 and D4).
 *
 * When the control plane deletes a cell it signs one grant, stored on the
 * cell's row, and cellctl relays it to the purge executors -- the key
 * custodian and the media edge. Each executor verifies the grant itself
 * (`cellctl`'s `deletion_grant.py`, the edge's `cell_deletion_grant.py`);
 * `contracts/cell-deletion-grants-v1.json` holds the grants every verifier
 * accepts or refuses alike. Change a claim here and in those verifiers in
 * the same release.
 *
 * The grant carries no `exp`: a deletion is final, so a grant stays true,
 * and a replayed grant finds nothing left to purge. The grace lives once,
 * here, as `purge_after = iat + CELL_DELETION_GRACE_SECONDS`; an executor
 * refuses a grant whose grace is under one day, so a bad configuration can
 * shorten but never remove the wait.
 */

import { decodeJwt } from "jose";
import {
  CLOUD_CELL_ID_PATTERN,
  loadCloudDeletionGrantSigningKey,
  type EnvironmentSource,
} from "./cloud-config";
import { signCloudJwt } from "./cloud-jwt";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";

/** The deletion grace (design G): from a cell's deletion to its purge. */
export const CELL_DELETION_GRACE_SECONDS = 7 * 86_400;

const CELL_DELETION_GRANT_AUDIENCE = "exomem-cell-delete";

/**
 * The signed grant for one deleted cell, or null while no deletion grant key
 * is configured. A cell ID outside the Cloud cell shape throws: the executors
 * turn it into a path segment, so a malformed one must never be signed.
 */
export async function signCloudDeletionGrant(
  cellId: string,
  options: { env?: EnvironmentSource; now?: number } = {}
): Promise<string | null> {
  if (!CLOUD_CELL_ID_PATTERN.test(cellId)) {
    throw new Error("a deletion grant names a Cloud cell ID");
  }
  const key = loadCloudDeletionGrantSigningKey(options.env);
  if (!key) return null;
  const now = options.now ?? Math.floor(Date.now() / 1000);
  return signCloudJwt(
    { cell_id: cellId, purge_after: now + CELL_DELETION_GRACE_SECONDS },
    {
      key,
      audience: CELL_DELETION_GRANT_AUDIENCE,
      lifetimeSeconds: null,
      now,
    }
  );
}

/**
 * Signs and stores the grant inside the transaction that set the cell's
 * desired_state to `deleted`; the caller must already hold that transaction.
 * The UPDATE re-checks `desired_state = 'deleted'` and a NULL grant, so a
 * call against a live cell or a second grant writes nothing rather than
 * replacing authority an executor may already hold.
 *
 * With no key configured the deletion still commits and the row keeps a NULL
 * grant; the unsigned event names no cell, matching the grant-missing logs
 * the cells emit.
 */
export async function recordCellDeletionGrant(
  tx: ExomemSql,
  cellId: string,
  options: { env?: EnvironmentSource; now?: number } = {}
): Promise<void> {
  const grant = await signCloudDeletionGrant(cellId, options);
  if (grant === null) {
    console.warn({ event: "exomem_cloud_deletion_grant_unsigned" });
    return;
  }
  await tx`
    /* exomem-cloud:record-deletion-grant */
    UPDATE exomem_cloud_cells
    SET deletion_grant = ${grant}
    WHERE cell_id = ${cellId}
      AND desired_state = 'deleted'
      AND deletion_grant IS NULL
  `;
}

export type CellDeletionSetEntry = {
  cellId: string;
  iat: number;
  purgeAfter: number;
  stoppedAt: number | null;
};

/**
 * Every cell deleted with a grant, for the key watcher's deletion set (D4).
 * The reported `iat` and `purge_after` come from the stored grant's own
 * payload, so the endpoint reports exactly what the executors verify -- one
 * source, never a recomputed copy. A stored grant that does not decode to
 * integer claims throws: the watcher treats an unreadable set as
 * DELETIONS_UNKNOWN, which is safe, whereas a partial set would let a hide
 * go uncounted.
 */
export async function readCellDeletionSet(): Promise<CellDeletionSetEntry[]> {
  const { rows } = await executeExomemSql`
    /* exomem-cloud:cell-deletion-set */
    SELECT cell_id, deletion_grant, deletion_stopped_at
    FROM exomem_cloud_cells
    WHERE desired_state = 'deleted'
      AND deletion_grant IS NOT NULL
    ORDER BY cell_id
  `;
  return rows.map((row) => {
    const payload = decodeJwt(String(row.deletion_grant));
    const iat = payload.iat;
    const purgeAfter = payload.purge_after;
    if (!Number.isInteger(iat) || !Number.isInteger(purgeAfter)) {
      throw new Error("a stored deletion grant does not decode to integer claims");
    }
    const stoppedAt = row.deletion_stopped_at;
    return {
      cellId: String(row.cell_id),
      iat: iat as number,
      purgeAfter: purgeAfter as number,
      stoppedAt:
        stoppedAt === null || stoppedAt === undefined
          ? null
          : Math.floor(new Date(stoppedAt as string).getTime() / 1000),
    };
  });
}

export type CellDeletionGrantBackfill = {
  /** Deleted cells without a grant when the run starts; a dry run counts them without signing. */
  missing: number;
  /** Cells this run signed; always 0 in a dry run. */
  signed: number;
};

/**
 * Signs a grant for every cell deleted before the signing key went live
 * (rollout step 10 of the Exomem change). Each cell is signed in its own
 * transaction that locks the row and re-checks it is still deleted and
 * grant-less, so a concurrent reconcile cannot be overwritten. A backfilled
 * grant starts a full grace. Counts only -- never a cell ID, which would put
 * tenant data in an operator log.
 */
export async function backfillCellDeletionGrants(options: {
  commit: boolean;
  env?: EnvironmentSource;
}): Promise<CellDeletionGrantBackfill> {
  // Refuse before any read: without the key every sign would be a no-op, and
  // a commit run that "succeeded" while signing nothing would report the
  // backfill done when nothing was granted.
  if (!loadCloudDeletionGrantSigningKey(options.env)) {
    throw new Error("EXOMEM_CLOUD_DELETION_GRANT_SIGNING_KEY is not configured");
  }
  const { rows } = await executeExomemSql`
    /* exomem-cloud:deletion-grant-backfill-candidates */
    SELECT cell_id
    FROM exomem_cloud_cells
    WHERE desired_state = 'deleted'
      AND deletion_grant IS NULL
    ORDER BY cell_id
  `;
  const result: CellDeletionGrantBackfill = { missing: rows.length, signed: 0 };
  for (const row of rows) {
    const cellId = String(row.cell_id);
    if (!options.commit) continue;
    await withExomemTransaction(async (tx) => {
      const { rows: locked } = await tx`
        /* exomem-cloud:deletion-grant-backfill-lock */
        SELECT cell_id
        FROM exomem_cloud_cells
        WHERE cell_id = ${cellId}
          AND desired_state = 'deleted'
          AND deletion_grant IS NULL
        FOR UPDATE
      `;
      if (locked.length === 0) return;
      await recordCellDeletionGrant(tx, cellId, options);
      result.signed += 1;
    });
  }
  return result;
}
