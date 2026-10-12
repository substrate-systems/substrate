/**
 * Exomem Cloud capacity: the one lock and the one count that every way in
 * (a start request, a waitlist promotion, an invite redemption, an operator
 * invitation) uses to decide whether a new person fits, and that the
 * operator page shows.
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

// The controller refreshes its observations on its ordinary passes. Older
// observations count as no capacity at all.
const OBSERVATION_FRESH_FOR = "5 minutes";

type CloudCapacityCounts = {
  freshObservations: number;
  freshSlots: number;
  liveCells: number;
  outstandingInvitations: number;
  newestObservationAt: string | null;
  /** Whether the address asked about already holds a live cell. */
  holdsLiveCell: boolean;
};

/**
 * - Fresh slots: capacity the controller observed in the last 5 minutes. A
 *   lost cluster connection leaves only stale observations, which count as
 *   zero, so nobody new is admitted on old numbers.
 * - Live cells: every cell row that still holds a slot, including a deleted
 *   cell whose cleanup the controller has not yet observed.
 * - Outstanding invitations: addresses holding an unused, unexpired
 *   invitation of any kind (start link, paid, complimentary or reviewer).
 *   Each address counts once, however many links it holds, because one
 *   person can only ever create one cell.
 * - Cell owners: an address whose owner already holds a live cell needs no
 *   new slot. Its invitations are left out of the count, and an invitation to
 *   it fits whatever the headroom (see `cloudAdmissionAllows`).
 *
 * `email` leaves out that address's own invitations: the slot that address
 * would take is the one being decided. `yieldOnlyToOlderInvitations` counts
 * only addresses whose invitation is older than that address's earliest
 * outstanding one.
 */
async function readCloudCapacity(
  sql: ExomemSql,
  email: string | null,
  yieldOnlyToOlderInvitations = false
): Promise<CloudCapacityCounts> {
  const result = await sql`
    /* exomem-cloud:capacity */
    WITH fresh AS (
      SELECT cell_slots FROM exomem_cloud_capacity
      WHERE observed_at > statement_timestamp() - ${OBSERVATION_FRESH_FOR}::interval
        AND observed_at <= statement_timestamp()
    ),
    cell_owners AS (
      SELECT users.email
      FROM users
      JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
      JOIN exomem_cloud_cells AS cell
        ON cell.tenant_id = tenant.id AND cell.desired_state <> 'deleted'
    ),
    -- With no outstanding invitation of its own, the address yields to all.
    turn AS (
      SELECT COALESCE(min(own.created_at), 'infinity'::timestamptz) AS created_at
      FROM exomem_invites AS own
      WHERE own.email_normalized = ${email}::citext
        AND own.consumed_at IS NULL
        AND own.revoked_at IS NULL
        AND own.expires_at > now()
    )
    SELECT
      (SELECT COUNT(*) FROM fresh) AS fresh_observations,
      (SELECT COALESCE(SUM(cell_slots), 0) FROM fresh) AS fresh_slots,
      (SELECT max(observed_at) FROM exomem_cloud_capacity
       WHERE observed_at <= statement_timestamp()) AS newest_observation_at,
      (SELECT COUNT(*) FROM exomem_cloud_cells
       WHERE desired_state <> 'deleted'
          OR observed_state IS DISTINCT FROM 'deleted'
          OR observed_generation IS DISTINCT FROM generation) AS live_cells,
      (SELECT COUNT(DISTINCT invite.email_normalized) FROM exomem_invites AS invite
       WHERE invite.consumed_at IS NULL
         AND invite.revoked_at IS NULL
         AND invite.expires_at > now()
         AND invite.email_normalized IS DISTINCT FROM ${email}::citext
         AND (NOT ${yieldOnlyToOlderInvitations}::boolean
              OR invite.created_at < (SELECT created_at FROM turn))
         AND NOT EXISTS (
           SELECT 1 FROM cell_owners WHERE cell_owners.email = invite.email_normalized
         )) AS outstanding_invitations,
      EXISTS (
        SELECT 1 FROM cell_owners WHERE cell_owners.email = ${email}::citext
      ) AS holds_live_cell
  `;
  const row = result.rows[0] as {
    fresh_observations: string;
    fresh_slots: string;
    newest_observation_at: Date | string | null;
    live_cells: string;
    outstanding_invitations: string;
    holds_live_cell: boolean;
  };
  return {
    freshObservations: Number(row.fresh_observations),
    freshSlots: Number(row.fresh_slots),
    liveCells: Number(row.live_cells),
    outstandingInvitations: Number(row.outstanding_invitations),
    newestObservationAt: row.newest_observation_at
      ? new Date(row.newest_observation_at).toISOString()
      : null,
    holdsLiveCell: row.holds_live_cell === true,
  };
}

/**
 * Whether Cloud has a slot for one more invitation to, or redemption by, one
 * address. Read it under `lockCloudCapacity`. An address that already holds
 * a live cell needs no new slot. Any other address needs one free slot: fresh
 * slots minus live cells minus other addresses' outstanding invitations.
 *
 * A redemption passes `yieldOnlyToOlderInvitations`: the address yields only
 * to addresses invited before its own earliest outstanding invitation, so a
 * person who asked again keeps their first link's turn. Issue-time checks
 * keep every invitation within capacity, so this changes nothing until
 * capacity shrinks below the invitations already out. Then the oldest
 * invitation still redeems while a slot exists, instead of every holder being
 * refused until enough of them expire.
 */
export async function cloudAdmissionAllows(
  tx: ExomemSql,
  request: { email: string; yieldOnlyToOlderInvitations?: boolean }
): Promise<boolean> {
  const counts = await readCloudCapacity(
    tx,
    request.email,
    request.yieldOnlyToOlderInvitations === true
  );
  if (counts.holdsLiveCell) return true;
  return counts.freshSlots - counts.liveCells - counts.outstandingInvitations >= 1;
}

export type CloudCapacityStatus = {
  /** Free places for a new address; `null` while no fresh observation exists. */
  freePlaces: number | null;
  freePlacesUnknownReason: "capacity_not_observed" | null;
  observedSlots: number;
  liveCells: number;
  outstandingInvitations: number;
  newestObservationAt: string | null;
};

/**
 * The operator page's capacity read: the same count admission uses. With no
 * fresh observation, admission treats capacity as zero, and the page shows
 * the count as unknown with its reason rather than as zero.
 */
export async function getCloudCapacityStatus(sql: ExomemSql): Promise<CloudCapacityStatus> {
  const counts = await readCloudCapacity(sql, null);
  const observed = counts.freshObservations > 0;
  return {
    freePlaces: observed
      ? Math.max(0, counts.freshSlots - counts.liveCells - counts.outstandingInvitations)
      : null,
    freePlacesUnknownReason: observed ? null : "capacity_not_observed",
    observedSlots: counts.freshSlots,
    liveCells: counts.liveCells,
    outstandingInvitations: counts.outstandingInvitations,
    newestObservationAt: counts.newestObservationAt,
  };
}
