/**
 * Exomem Cloud capacity: the one lock and the one count that every way in
 * (a start request, a waitlist promotion, an invite redemption, a paid
 * operator invite) uses to decide whether a new person fits.
 */

import type { ExomemSql } from "./db";

/**
 * Serializes every admission decision. Exclusive, not shared: capacity is an
 * aggregate over many rows, so only a serializing lock stops two concurrent
 * decisions from both seeing the last free slot. Take it before any
 * write-bearing statement in the transaction.
 */
export async function lockCloudCapacity(tx: ExomemSql): Promise<void> {
  await tx`SELECT pg_advisory_xact_lock(hashtext('exomem-cloud-capacity'))`;
}

/**
 * Free Cloud slots: fresh slots minus live cells minus outstanding promises.
 *
 * - Fresh slots: capacity the controller observed in the last 5 minutes. A
 *   lost cluster connection leaves only stale observations, which count as
 *   zero, so nobody new is admitted on old numbers.
 * - Live cells: every cell row that still holds a slot, including a deleted
 *   cell whose cleanup the controller has not yet observed.
 * - Outstanding promises: unexpired, unused start links, and paid operator
 *   invites, which are also admitted against this count. Without them, every
 *   request would see the same free slot and all of them would be promised it.
 *
 * `excludingInviteId` leaves out the invite being redeemed: its promise turns
 * into the cell it creates. The result can be negative.
 */
export async function cloudAdmissionHeadroom(
  tx: ExomemSql,
  options: { excludingInviteId?: string } = {}
): Promise<number> {
  const result = await tx`
    /* exomem-cloud:admission-headroom */
    SELECT
      (SELECT COALESCE(SUM(cell_slots), 0) FROM exomem_cloud_capacity
       WHERE observed_at > statement_timestamp() - interval '5 minutes'
         AND observed_at <= statement_timestamp()) AS fresh_slots,
      (SELECT COUNT(*) FROM exomem_cloud_cells
       WHERE desired_state <> 'deleted'
          OR observed_state IS DISTINCT FROM 'deleted'
          OR observed_generation IS DISTINCT FROM generation) AS live_cells,
      (SELECT COUNT(*) FROM exomem_invites
       WHERE (self_serve OR entitlement_source = 'paddle')
         AND consumed_at IS NULL
         AND revoked_at IS NULL
         AND expires_at > now()
         AND id IS DISTINCT FROM ${options.excludingInviteId ?? null}::uuid) AS promised
  `;
  const row = result.rows[0] as { fresh_slots: string; live_cells: string; promised: string };
  return Number(row.fresh_slots) - Number(row.live_cells) - Number(row.promised);
}
