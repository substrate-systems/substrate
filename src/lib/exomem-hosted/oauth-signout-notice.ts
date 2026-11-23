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

import { loadExomemCloudResource } from "./cloud-config";
import { executeExomemSql, withExomemTransaction } from "./db";
import { enqueueExomemEmail, SIGNOUT_RECENT_USE_DAYS } from "./email-outbox";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { OAUTH_FAMILY_END_SILENT_REASONS } from "./oauth-family-end";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import type { ExomemThemeChoice } from "@/lib/exomem/theme";

/** The latest-ended unmarked ending considered per grant each run, per partition. */
const SIGNOUT_CANDIDATES_PER_SWEEP = 100;
/** Endings older than this are stale news: the sweep looks back no further. */
const SIGNOUT_LOOKBACK_HOURS = 25;
/** At most one sign-out email per grant in this window, enforced on emailed markers. */
const SIGNOUT_CAP_HOURS = 24;
/**
 * Markers live long enough to answer the send-time recheck and span the cap;
 * past this age the sweep deletes the oldest per run, bounded like the
 * sweep's other prunes.
 */
const SIGNOUT_MARKER_KEEP_DAYS = 30;
const SIGNOUT_MARKER_DELETIONS_PER_SWEEP = 500;

export type AppSignoutSweepResult = {
  /** Latest-ended unmarked families listed this run, before eligibility. */
  candidates: number;
  /** Families whose marker and email were claimed this run. */
  emailed: number;
};

type SignoutCandidate = { family_id: string; grant_id: string };

/**
 * The per-grant latest-ended family that is worth deciding on this run. A
 * family's ending is the earlier of its revocation and the moment its last
 * usable credential expired (exomem_oauth_family_live_until /
 * exomem_oauth_family_ended_at — the same pair Home's reachability reads).
 * Two drivers land the endings inside the lookback on their own range
 * scans: a revocation stamped inside the window and a family's last
 * unconsumed refresh token expiring. Only refresh-bearing families produce
 * an ending: a family issued without refresh loses reachability by design
 * when its access token lapses minutes after sign-in, so treating that as
 * an ending would email a still-in-use app every day — and a revocation of
 * one says nothing the owner could act on either. The per-driver "is this
 * the last" check probes the per-family indexes, so the lane never scans a
 * token table end to end.
 *
 * The ending that actually took reachability is always the *latest* one, so
 * the `DISTINCT ON` picks it before any per-ending predicate applies: an
 * earlier ending can never backfill a notice for a death already attributed.
 * Outside sit the per-ending checks — unmarked, not a silent ending — and
 * the grant-level facts, probed per candidate. The grant facts also fix
 * "connected app" the way Home defines it: the Cloud resource and a client
 * that is not first-party, so Home's own channel families — no-refresh by
 * design — can never email the owner about themselves.
 */
async function listSignoutCandidates(limit: number): Promise<SignoutCandidate[]> {
  const resource = loadExomemCloudResource().mcpUrl;
  const { rows } = await executeExomemSql`
    /* exomem:app-signout-candidates */
    SELECT latest.family_id, latest.grant_id
    FROM (
      SELECT DISTINCT ON (ended.grant_id)
             ended.family_id, ended.grant_id, ended.ended_at, ended.ended_reason
      FROM (
        -- A revocation inside the lookback; the credential may have ended
        -- the reachability earlier, and LEAST takes whichever came first.
        SELECT family.id AS family_id, family.grant_id,
               exomem_oauth_family_ended_at(family.revoked_at, live.live_until) AS ended_at,
               family.revoked_reason AS ended_reason
        FROM exomem_oauth_token_families AS family
        CROSS JOIN LATERAL (
          SELECT exomem_oauth_family_live_until(family.id) AS live_until
        ) AS live
        WHERE family.revoked_at > now() - (${SIGNOUT_LOOKBACK_HOURS} * interval '1 hour')
          AND EXISTS (
            SELECT 1 FROM exomem_oauth_refresh_tokens AS refresh
            WHERE refresh.family_id = family.id
          )

        UNION ALL

        -- An unrevoked family's last unconsumed refresh token expired. The
        -- family is fetched per token through a fenced lateral probe: the
        -- lane's cost follows recently ended tokens, never table size.
        SELECT family.id, family.grant_id, token.expires_at, NULL
        FROM exomem_oauth_refresh_tokens AS token
        CROSS JOIN LATERAL (
          SELECT family.id, family.grant_id
          FROM exomem_oauth_token_families AS family
          WHERE family.id = token.family_id AND family.revoked_at IS NULL
          OFFSET 0
        ) AS family
        WHERE token.consumed_at IS NULL
          AND token.expires_at <= now()
          AND token.expires_at > now() - (${SIGNOUT_LOOKBACK_HOURS} * interval '1 hour')
          AND NOT EXISTS (
            SELECT 1
            FROM exomem_oauth_refresh_tokens AS newer
            WHERE newer.family_id = token.family_id AND newer.consumed_at IS NULL
              AND newer.expires_at > token.expires_at
            OFFSET 0
          )
      ) AS ended
      WHERE ended.ended_at <= now()
        AND ended.ended_at > now() - (${SIGNOUT_LOOKBACK_HOURS} * interval '1 hour')
      ORDER BY ended.grant_id, ended.ended_at DESC, ended.family_id
    ) AS latest
    WHERE NOT EXISTS (
      SELECT 1
      FROM exomem_oauth_app_signout_notices AS notice
      WHERE notice.family_id = latest.family_id
    )
      AND NOT EXISTS (
        SELECT 1
        FROM exomem_oauth_app_signout_notices AS notice
        WHERE notice.grant_id = latest.grant_id
          AND notice.ended_at = latest.ended_at
      )
      AND (latest.ended_reason IS NULL
           OR latest.ended_reason <> ALL(${[...OAUTH_FAMILY_END_SILENT_REASONS]}::text[]))
      -- The grant still has no live family: the sibling's own tokens decide,
      -- not its row's expiry ceiling.
      AND NOT EXISTS (
        SELECT 1
        FROM exomem_oauth_token_families AS sibling
        WHERE sibling.grant_id = latest.grant_id
          AND sibling.revoked_at IS NULL
          AND exomem_oauth_family_live_until(sibling.id) > now()
      )
      -- The grant-level facts — a live connected-app grant on a live,
      -- non-reviewer account, still used recently — probe per candidate by
      -- primary key. The OFFSET 0 keeps the planner from hoisting them into
      -- a semi-join over every grant: the lane's cost must follow recently
      -- ended families, not table size.
      AND EXISTS (
        SELECT 1
        FROM exomem_oauth_grants AS oauth_grant
        JOIN exomem_oauth_clients AS client
          ON client.id = oauth_grant.client_id AND client.admission_mode <> 'first_party'
        JOIN exomem_tenants AS tenant
          ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
           AND tenant.status IN ('provisioning', 'active', 'suspended')
           AND tenant.deleted_at IS NULL
           AND NOT tenant.marketplace_reviewer_purpose
        JOIN exomem_users AS owner
          ON owner.id = tenant.owner_user_id AND owner.deleted_at IS NULL
        JOIN exomem_oauth_grant_usage AS app_use
          ON app_use.grant_id = oauth_grant.id
           AND app_use.last_used_at > now() - (${SIGNOUT_RECENT_USE_DAYS} * interval '1 day')
        WHERE oauth_grant.id = latest.grant_id AND oauth_grant.revoked_at IS NULL
          AND oauth_grant.resource = ${resource}
        OFFSET 0
      )
    ORDER BY latest.ended_at ASC
    LIMIT ${limit}
  `;
  return rows as unknown as SignoutCandidate[];
}

type ClaimedAppSignout = {
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
 * Claims the endings that still qualify: the tenants are locked first in
 * their own statement, then the grants, so a concurrent sweep decides the
 * same grant serially — the claim statement's READ COMMITTED snapshot then
 * postdates the locks, seeing everything a just-finished sweep committed.
 * Tenant-then-grant is the order every path that writes these rows already
 * takes — code exchange, disconnect and account revocation all lock the
 * tenant FOR UPDATE first — so the outbox insert's tenant key-share can
 * never wait on a grant holder that itself waits on this tenant. Both locks
 * are FOR NO KEY UPDATE: the sweep never writes either row, and the weaker
 * mode does not block the key-share lock code exchange takes on the grant
 * through its family insert. Then each candidate is re-verified (live
 * grant, live tenant and owner, recent use, still a connected app, not a
 * silent ending, still no live family, no emailed marker inside the cap)
 * and its marker is inserted once per family. The returned rows carry
 * everything the enqueue needs, so the email is written against the same
 * verified state the marker was.
 */
async function claimEndedFamilyNotices(
  tx: Parameters<Parameters<typeof withExomemTransaction>[0]>[0],
  candidates: readonly SignoutCandidate[]
): Promise<ClaimedAppSignout[]> {
  const resource = loadExomemCloudResource().mcpUrl;
  const familyIds = candidates.map((candidate) => candidate.family_id);
  const grantIds = candidates.map((candidate) => candidate.grant_id);
  // Tenant locks first, in id order — the codebase's order on every path
  // that writes these rows — so the outbox insert's tenant key-share never
  // waits on a grant holder waiting on this tenant.
  await tx`
    /* exomem:app-signout-tenant-lock */
    SELECT tenant.id
    FROM exomem_tenants AS tenant
    JOIN exomem_oauth_grants AS oauth_grant ON oauth_grant.tenant_id = tenant.id
    WHERE oauth_grant.id = ANY(${grantIds}::uuid[])
    ORDER BY tenant.id
    FOR NO KEY UPDATE OF tenant
  `;
  await tx`
    /* exomem:app-signout-lock */
    SELECT oauth_grant.id
    FROM exomem_oauth_grants AS oauth_grant
    WHERE oauth_grant.id = ANY(${grantIds}::uuid[])
    ORDER BY oauth_grant.id
    FOR NO KEY UPDATE
  `;
  const { rows } = await tx`
    /* exomem:app-signout-claim */
    WITH picked AS (
      SELECT *
      FROM unnest(${familyIds}::uuid[], ${grantIds}::uuid[]) AS picked (family_id, grant_id)
    ), eligible AS (
      SELECT picked.family_id, picked.grant_id,
             exomem_oauth_family_ended_at(family.revoked_at, live.live_until) AS ended_at,
             family.revoked_reason AS ended_reason
      FROM picked
      JOIN exomem_oauth_token_families AS family
        ON family.id = picked.family_id AND family.grant_id = picked.grant_id
      CROSS JOIN LATERAL (
        SELECT exomem_oauth_family_live_until(family.id) AS live_until
      ) AS live
      JOIN exomem_oauth_grants AS oauth_grant
        ON oauth_grant.id = picked.grant_id AND oauth_grant.revoked_at IS NULL
         AND oauth_grant.resource = ${resource}
      JOIN exomem_oauth_clients AS client
        ON client.id = oauth_grant.client_id AND client.admission_mode <> 'first_party'
      JOIN exomem_tenants AS tenant
        ON tenant.id = oauth_grant.tenant_id AND tenant.owner_user_id = oauth_grant.user_id
         AND tenant.status IN ('provisioning', 'active', 'suspended')
         AND tenant.deleted_at IS NULL
         AND NOT tenant.marketplace_reviewer_purpose
      JOIN exomem_users AS owner
        ON owner.id = tenant.owner_user_id AND owner.deleted_at IS NULL
      JOIN exomem_oauth_grant_usage AS app_use
        ON app_use.grant_id = oauth_grant.id
         AND app_use.last_used_at > now() - (${SIGNOUT_RECENT_USE_DAYS} * interval '1 day')
      WHERE (family.revoked_reason IS NULL
             OR family.revoked_reason <> ALL(${[...OAUTH_FAMILY_END_SILENT_REASONS]}::text[]))
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_token_families AS sibling
          WHERE sibling.grant_id = picked.grant_id
            AND sibling.revoked_at IS NULL
            AND exomem_oauth_family_live_until(sibling.id) > now()
        )
        -- Still the latest ending: a refresh-bearing family that ended
        -- between list and claim owns the notice instead (or suppresses it,
        -- when it is a silent ending).
        AND NOT EXISTS (
          SELECT 1
          FROM exomem_oauth_token_families AS newer
          WHERE newer.grant_id = picked.grant_id
            AND EXISTS (
              SELECT 1 FROM exomem_oauth_refresh_tokens AS refresh
              WHERE refresh.family_id = newer.id
            )
            AND exomem_oauth_family_ended_at(
                  newer.revoked_at, exomem_oauth_family_live_until(newer.id)
                ) > exomem_oauth_family_ended_at(family.revoked_at, live.live_until)
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
                  = exomem_oauth_family_ended_at(family.revoked_at, live.live_until)
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
 * One sweep tick: retire markers the cap and the send-time recheck can no
 * longer reach, list the unmarked last-endings in the lookback, then in one
 * transaction claim the eligible ones and enqueue their emails — the marker
 * insert and the enqueue share the transaction, so a crash cannot produce
 * one without the other, and the outbox's dedupe key is the second belt for
 * exactly-once enqueue. Each emailed notice is then reported as a
 * metadata-only operational event. Bounded per run; a queue of more than
 * the limit drains over consecutive ticks.
 */
export async function notifyEndedAppSessions(
  options: {
    limit?: number;
  } = {}
): Promise<AppSignoutSweepResult> {
  await executeExomemSql`
    /* exomem:app-signout-prune-markers */
    DELETE FROM exomem_oauth_app_signout_notices
    WHERE family_id IN (
      SELECT family_id
      FROM exomem_oauth_app_signout_notices
      WHERE emailed_at < now() - (${SIGNOUT_MARKER_KEEP_DAYS} * interval '1 day')
      ORDER BY emailed_at
      LIMIT ${SIGNOUT_MARKER_DELETIONS_PER_SWEEP}
    )
  `;
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
