/**
 * The owner sign-out notice (notify-owner-of-app-signout): when an app's last
 * live token family ends without the owner's action, the owner should hear
 * about it — a quiet app that can no longer reach the cell looks exactly like
 * one that can. Detection runs inside the OAuth sweep
 * (pruneExpiredOAuthState): one batched read of recently ended families, then
 * one claiming transaction that locks the affected grants, re-verifies each
 * candidate, marks it once per family and enqueues the email. Only OAuth
 * metadata is read; never tenant content.
 */

import { executeExomemSql, withExomemTransaction } from "./db";
import { enqueueExomemEmail, SIGNOUT_RECENT_USE_DAYS } from "./email-outbox";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";

/** The latest-ended unmarked ending considered per grant each run, per partition. */
const SIGNOUT_CANDIDATES_PER_SWEEP = 100;
/** Endings older than this are stale news: the sweep looks back no further. */
const SIGNOUT_LOOKBACK_HOURS = 25;
/** The recent-use window, shared with the send-time recheck (email-outbox.ts). */
export { SIGNOUT_RECENT_USE_DAYS };
/** At most one sign-out email per grant in this window, enforced on emailed markers. */
const SIGNOUT_CAP_HOURS = 24;

/**
 * The endings that never email — a closed set because `revoked_reason` is
 * written only by this codebase: the owner's own disconnect, the client's own
 * revocation, and the lifecycle paths that take the grant with them. An
 * expiry carries no reason and every other existing reason
 * (`refresh_replayed`, `operator_revoked`) is a system ending that notifies.
 */
export const FAMILY_END_SILENT_REASONS = [
  "owner_disconnected",
  "client_revoked",
  "lifecycle_deleted",
  "cloud_cell_deleted",
  "reviewer_credential_revoked",
] as const;

export type AppSignoutSweepResult = {
  /** Latest-ended unmarked families listed this run, before eligibility. */
  candidates: number;
  /** Families whose marker and email were claimed this run. */
  emailed: number;
};

type SignoutCandidate = { family_id: string; grant_id: string };

/**
 * The per-grant latest-ended family that is worth deciding on this run. The
 * ending that actually took reachability is always the *latest* one, so the
 * `DISTINCT ON` picks it before any per-ending predicate applies: an earlier
 * ending can never backfill a notice for a death already attributed — when
 * the latest ending is marked, silent, or lands while the cap still holds,
 * the grant simply yields no candidate.
 *
 * The live-sibling check sits inside the selection (it must hold for the
 * ending to take reachability); outside sit the per-ending checks —
 * unmarked, not a silent ending — and the grant-level facts, probed per
 * candidate. The one predicate left for the claim alone is the 24-hour
 * cap, because it lifts again and a suppressed ending must stay a
 * candidate until it does.
 */
async function listSignoutCandidates(limit: number): Promise<SignoutCandidate[]> {
  const { rows } = await executeExomemSql`
    /* exomem:app-signout-candidates */
    SELECT ended.family_id, ended.grant_id
    FROM (
      SELECT DISTINCT ON (family.grant_id)
             family.id AS family_id, family.grant_id,
             exomem_oauth_family_ended_at(family.revoked_at, family.expires_at) AS ended_at,
             family.revoked_reason AS ended_reason
      FROM exomem_oauth_token_families AS family
      WHERE exomem_oauth_family_ended_at(family.revoked_at, family.expires_at) <= now()
        AND exomem_oauth_family_ended_at(family.revoked_at, family.expires_at)
              > now() - (${SIGNOUT_LOOKBACK_HOURS} * interval '1 hour')
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_token_families AS sibling
          WHERE sibling.grant_id = family.grant_id
            AND sibling.revoked_at IS NULL
            AND sibling.expires_at > now()
        )
      ORDER BY family.grant_id,
               exomem_oauth_family_ended_at(family.revoked_at, family.expires_at) DESC,
               -- Same-instant endings (a mass revocation stamps one now() on
               -- them all) pick the same family every run.
               family.id
    ) AS ended
    WHERE NOT EXISTS (
      SELECT 1
      FROM exomem_oauth_app_signout_notices AS notice
      WHERE notice.family_id = ended.family_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM exomem_oauth_app_signout_notices AS notice
        WHERE notice.grant_id = ended.grant_id
          AND notice.ended_at = ended.ended_at
      )
      AND (ended.ended_reason IS NULL
           OR ended.ended_reason <> ALL(${[...FAMILY_END_SILENT_REASONS]}::text[]))
      -- The grant-level facts — live grant on a live account, still used
      -- recently — probe per candidate by primary key. The OFFSET 0 keeps
      -- the planner from hoisting them into a semi-join over every grant:
      -- the lane's cost must follow recently ended families, not table
      -- size.
      AND EXISTS (
        SELECT 1
        FROM exomem_oauth_grants AS oauth_grant
        JOIN exomem_tenants AS tenant
          ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
           AND tenant.status IN ('provisioning', 'active', 'suspended')
           AND tenant.deleted_at IS NULL
        JOIN exomem_users AS owner
          ON owner.id = tenant.owner_user_id AND owner.deleted_at IS NULL
        JOIN exomem_oauth_grant_usage AS app_use
          ON app_use.grant_id = oauth_grant.id
           AND app_use.last_used_at > now() - (${SIGNOUT_RECENT_USE_DAYS} * interval '1 day')
        WHERE oauth_grant.id = ended.grant_id AND oauth_grant.revoked_at IS NULL
        OFFSET 0
      )
    ORDER BY ended.ended_at ASC
    LIMIT ${limit}
  `;
  return rows as unknown as SignoutCandidate[];
}

export type ClaimedAppSignout = {
  family_id: string;
  grant_id: string;
  ended_at: string;
  ended_reason: string | null;
  tenant_id: string;
  owner_email: string;
  time_zone: string | null;
  email_scheme: ExomemEmailScheme | null;
  theme_choice: ExomemThemeChoice | null;
  client_name: string | null;
  admission_mode: string;
  client_platform: string | null;
  redirect_uris: string[];
};

/**
 * Claims the endings that still qualify: the grants are locked first in their
 * own statement so a concurrent sweep decides the same grant serially — the
 * claim statement's READ COMMITTED snapshot then postdates the lock, seeing
 * everything a just-finished sweep committed (a lock inside the claim itself
 * would wait but still read the pre-wait snapshot). Then each candidate is
 * re-verified (live grant, live tenant and owner, recent use, not a silent
 * ending, still no live family, no emailed marker inside the cap) and its
 * marker is inserted once per family. The returned rows carry everything the
 * enqueue needs, so the email is written against the same verified state the
 * marker was.
 */
async function claimEndedFamilyNotices(
  tx: Parameters<Parameters<typeof withExomemTransaction>[0]>[0],
  candidates: readonly SignoutCandidate[]
): Promise<ClaimedAppSignout[]> {
  const familyIds = candidates.map((candidate) => candidate.family_id);
  const grantIds = candidates.map((candidate) => candidate.grant_id);
  await tx`
    /* exomem:app-signout-lock */
    SELECT oauth_grant.id
    FROM exomem_oauth_grants AS oauth_grant
    WHERE oauth_grant.id = ANY(${grantIds}::uuid[])
    ORDER BY oauth_grant.id
    FOR UPDATE
  `;
  const { rows } = await tx`
    /* exomem:app-signout-claim */
    WITH picked AS (
      SELECT *
      FROM unnest(${familyIds}::uuid[], ${grantIds}::uuid[]) AS picked (family_id, grant_id)
    ), eligible AS (
      SELECT picked.family_id, picked.grant_id,
             exomem_oauth_family_ended_at(family.revoked_at, family.expires_at) AS ended_at,
             family.revoked_reason AS ended_reason
      FROM picked
      JOIN exomem_oauth_token_families AS family
        ON family.id = picked.family_id AND family.grant_id = picked.grant_id
      JOIN exomem_oauth_grants AS oauth_grant
        ON oauth_grant.id = picked.grant_id AND oauth_grant.revoked_at IS NULL
      JOIN exomem_tenants AS tenant
        ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
         AND tenant.status IN ('provisioning', 'active', 'suspended')
         AND tenant.deleted_at IS NULL
      JOIN exomem_users AS owner
        ON owner.id = tenant.owner_user_id AND owner.deleted_at IS NULL
      JOIN exomem_oauth_grant_usage AS app_use
        ON app_use.grant_id = oauth_grant.id
         AND app_use.last_used_at > now() - (${SIGNOUT_RECENT_USE_DAYS} * interval '1 day')
      WHERE (family.revoked_reason IS NULL
             OR family.revoked_reason <> ALL(${[...FAMILY_END_SILENT_REASONS]}::text[]))
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_token_families AS sibling
          WHERE sibling.grant_id = picked.grant_id
            AND sibling.revoked_at IS NULL
            AND sibling.expires_at > now()
        )
        -- Still the latest ending: a family that ended between list and
        -- claim owns the notice instead (or suppresses it, when it is a
        -- silent ending).
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_token_families AS newer
          WHERE newer.grant_id = picked.grant_id
            AND exomem_oauth_family_ended_at(newer.revoked_at, newer.expires_at)
                  > exomem_oauth_family_ended_at(family.revoked_at, family.expires_at)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_app_signout_notices AS notice
          WHERE notice.grant_id = picked.grant_id
            AND notice.emailed_at > now() - (${SIGNOUT_CAP_HOURS} * interval '1 hour')
        )
        -- An ending at the same instant was already attributed by its twin's
        -- emailed marker; a second email would retell the same sign-out.
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_app_signout_notices AS notice
          WHERE notice.grant_id = picked.grant_id
            AND notice.ended_at
                  = exomem_oauth_family_ended_at(family.revoked_at, family.expires_at)
        )
    ), marked AS (
      INSERT INTO exomem_oauth_app_signout_notices (family_id, grant_id, ended_at, ended_reason, emailed_at)
      SELECT family_id, grant_id, ended_at, ended_reason, now()
      FROM eligible
      ON CONFLICT (family_id) DO NOTHING
      RETURNING family_id, grant_id, ended_at, ended_reason
    )
    SELECT marked.family_id, marked.grant_id, marked.ended_at::text AS ended_at,
           marked.ended_reason,
           oauth_grant.tenant_id,
           owner.email::text AS owner_email, tenant.time_zone, tenant.email_scheme, tenant.theme_choice,
           client.client_name, client.admission_mode, client.client_platform, client.redirect_uris
    FROM marked
    JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.id = marked.grant_id
    JOIN exomem_tenants AS tenant ON tenant.id = oauth_grant.tenant_id
    JOIN exomem_users AS owner ON owner.id = tenant.owner_user_id
    JOIN exomem_oauth_clients AS client ON client.id = oauth_grant.client_id
    ORDER BY marked.ended_at
  `;
  return rows as unknown as ClaimedAppSignout[];
}

/**
 * One sweep tick: list the unmarked last-endings in the lookback, then in one
 * transaction claim the eligible ones and enqueue their emails — the marker
 * insert and the enqueue share the transaction, so a crash cannot produce
 * one without the other, and the outbox's dedupe key is the second belt for
 * exactly-once enqueue. Each emailed notice is then reported as a
 * metadata-only operational event. Bounded per run; a queue of more than the
 * limit drains over consecutive ticks.
 */
export async function notifyEndedAppSessions(options: {
  limit?: number;
} = {}): Promise<AppSignoutSweepResult> {
  const candidates = await listSignoutCandidates(options.limit ?? SIGNOUT_CANDIDATES_PER_SWEEP);
  if (candidates.length === 0) return { candidates: 0, emailed: 0 };
  const claimed = await withExomemTransaction(async (tx) => {
    const rows = await claimEndedFamilyNotices(tx, candidates);
    for (const row of rows) {
      await enqueueExomemEmail(tx, {
        kind: "app_signout",
        dedupeKey: `app-signout:${row.family_id}`,
        recipient: row.owner_email,
        recipientTimeZone: row.time_zone,
        recipientEmailScheme: row.email_scheme,
        recipientThemeChoice: row.theme_choice,
        tenantId: row.tenant_id,
        payload: { version: 1, grantId: row.grant_id, familyId: row.family_id },
      });
    }
    return rows;
  });
  for (const row of claimed) {
    emitOperationalEvent(
      buildOperationalEvent({
        event: "oauth.app_signout.notified",
        outcome: "succeeded",
        tenantId: row.tenant_id,
        emailKind: "app_signout",
      })
    );
  }
  return { candidates: candidates.length, emailed: claimed.length };
}
