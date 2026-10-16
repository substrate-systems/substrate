/**
 * Self-serve admission for "Start with your email": a person who owns no
 * Exomem gets a start link while Cloud has a free slot and nobody is waiting,
 * and a waitlist place otherwise. Waiting people are promoted first come,
 * first served when a slot frees. Every decision runs under the Cloud
 * capacity lock and enqueues its email in the same transaction, so the page
 * response never depends on the outcome.
 */

import { createHash } from "node:crypto";
import { cloudAdmissionAllows, lockCloudCapacity } from "./cloud-capacity";
import { executeExomemSql, takeRateLimit, withExomemTransaction, type ExomemSql } from "./db";
import { enqueueExomemEmail } from "./email-outbox";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit, type ExomemRateLimitRule } from "./rate-limit";
import { generateExternalToken, tokenDigest, type RandomBytesSource } from "./security";

/**
 * `EXOMEM_SELF_SERVE_ADMISSION`:
 * - `waitlist` (the default): everybody new is queued.
 * - `open`: a free slot admits, otherwise the person is queued, and a freed
 *   slot promotes the oldest waiting person.
 */
export type SelfServeAdmissionMode = "waitlist" | "open";

/**
 * An unknown value reads as `waitlist`: the person gets feedback without
 * a typo opening admission.
 */
export function selfServeAdmissionMode(
  value: string | undefined = process.env.EXOMEM_SELF_SERVE_ADMISSION
): SelfServeAdmissionMode {
  return value === "open" ? "open" : "waitlist";
}

/**
 * `EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR`: how many start links `open` mode
 * hands out an hour, to newcomers and promoted waiting people together. An
 * unset value, or one that is not a positive whole number, reads as the
 * default in rate-limit.ts; a larger value than the cap below reads as the cap.
 */
function selfServeAdmissionPace(
  value: string | undefined = process.env.EXOMEM_SELF_SERVE_ADMISSIONS_PER_HOUR
): ExomemRateLimitRule {
  const rule = EXOMEM_RATE_LIMITS.selfServeAdmission;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1) return rule;
  // The bucket's admitted_count is a PostgreSQL integer; a larger limit fails every take.
  return { ...rule, limit: Math.min(limit, 2_147_483_647) };
}

// The pace counts admissions, not people: every address shares one bucket,
// because one person can type any number of addresses.
const SELF_SERVE_PACE_KEY = "everybody";

/**
 * Takes one admission from the self-serve pace, in the admission's own
 * transaction under the capacity lock, so an admission that rolls back takes
 * nothing. It stops one person from holding Cloud slots with many addresses.
 * When it fires wrongly, a real person waits in the queue for a later
 * promotion, and nothing else is lost.
 */
async function takeSelfServeAdmission(tx: ExomemSql): Promise<boolean> {
  const allowed = await takeExomemRateLimit(selfServeAdmissionPace(), SELF_SERVE_PACE_KEY, {
    take: (input) => takeRateLimit(input, tx),
  });
  if (!allowed) {
    emitOperationalEvent(
      buildOperationalEvent({
        event: "access.start.admission_paced",
        outcome: "denied",
        errorCode: "RATE_LIMITED",
      })
    );
  }
  return allowed;
}

/**
 * Shorter than an operator invitation's 30-day ceiling: an outstanding start
 * link holds a Cloud slot, so an abandoned start must return it within two
 * days rather than a month.
 */
const START_LINK_TTL_MS = 48 * 60 * 60 * 1000;
// A waitlist confirmation that cannot be delivered within a day is stale: the
// person has asked again by then.
const WAITLIST_EMAIL_TTL_MS = 24 * 60 * 60 * 1000;

// `created_by_principal_digest` is NOT NULL because operator invites are
// attributable. Nobody authorised a self-serve invite, so it carries a fixed
// sentinel rather than a made-up operator identity.
const SELF_SERVE_PRINCIPAL_DIGEST = createHash("sha256")
  .update("exomem:self-serve-admission")
  .digest();

// What every Exomem invitation, start link or operator invite, grants.
export const EXOMEM_INVITE_CAPABILITIES = ["capture", "recall", "export"];
export const EXOMEM_INVITE_LIMITS = {
  storageBytes: 5 * 1024 * 1024 * 1024,
  uploadBytes: 90 * 1024 * 1024,
  workerCount: 0,
};

export type StartOutcome = "admitted" | "reissued" | "waitlisted";

type StartLinkMaterial = { token: string; digest: Buffer };

function mintStartLink(randomBytes?: RandomBytesSource): StartLinkMaterial {
  const token = generateExternalToken(randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw new Error("start link token has no digest");
  return { token, digest };
}

async function insertStartLink(
  tx: ExomemSql,
  input: {
    emailNormalized: string;
    link: StartLinkMaterial;
    /** An ISO timestamp, or the database's own text form of one. */
    expiresAt: string;
  }
): Promise<{ inviteId: string; expiresAt: string }> {
  const { rows } = await tx`
    /* exomem:insert-start-link */
    INSERT INTO exomem_invites (
      token_digest, email_normalized, entitlement_source, entitlement_capabilities,
      entitlement_limits, marketplace_reviewer_purpose, created_by_principal_digest,
      expires_at, self_serve, recipient_time_zone
    ) VALUES (
      ${input.link.digest},
      ${input.emailNormalized},
      'paddle',
      ${JSON.stringify(EXOMEM_INVITE_CAPABILITIES)}::jsonb,
      ${JSON.stringify(EXOMEM_INVITE_LIMITS)}::jsonb,
      false,
      ${SELF_SERVE_PRINCIPAL_DIGEST},
      ${input.expiresAt}::timestamptz,
      true,
      -- A start request uses its browser zone for delivery, never as a stored preference.
      NULL
    )
    RETURNING id, expires_at
  `;
  const row = rows[0] as { id: string; expires_at: Date | string } | undefined;
  if (!row) throw new Error("start link insert returned no row");
  return {
    inviteId: row.id,
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

async function enqueueStartLinkEmail(
  tx: ExomemSql,
  input: {
    kind: "start" | "place_opened";
    emailNormalized: string;
    timeZone: string | null;
    link: StartLinkMaterial;
    invite: { inviteId: string; expiresAt: string };
  }
): Promise<void> {
  await enqueueExomemEmail(tx, {
    kind: input.kind,
    dedupeKey: `start:${input.invite.inviteId}`,
    recipient: input.emailNormalized,
    recipientTimeZone: input.timeZone,
    payload: {
      version: 1,
      inviteId: input.invite.inviteId,
      token: input.link.token,
      expiresAt: input.invite.expiresAt,
    },
    expiresAt: new Date(input.invite.expiresAt),
  });
}

/**
 * The self-serve branch of a start request, for a person who owns no
 * Exomem, in one transaction under the Cloud capacity lock:
 *
 * 1. A person who still holds an unused, unexpired start link gets a fresh
 *    one too, with the same expiry. They were admitted before anybody now
 *    waiting, and keeping the expiry stops a repeat request from holding a
 *    slot forever. Their earlier links stay valid: anyone can submit their
 *    address, so a request must not cancel a link they are about to open.
 *    Using any one of the links revokes the rest (cloud-admission.ts).
 * 2. In `open` mode, a free slot admits them, but only while nobody is
 *    waiting, so a newcomer never overtakes the queue, and only while the
 *    self-serve pace has room.
 * 3. Otherwise they are queued. A person already waiting keeps their place,
 *    so asking again never costs them it. A person whose earlier start link
 *    lapsed unused goes to the back, because they already had a turn.
 */
export async function startSelfServeAtomic(input: {
  emailNormalized: string;
  timeZone: string | null;
  mode: "waitlist" | "open";
  randomBytes?: RandomBytesSource;
}): Promise<StartOutcome> {
  const link = mintStartLink(input.randomBytes);
  return withExomemTransaction(async (tx) => {
    await lockCloudCapacity(tx);

    const outstanding = await tx`
      /* exomem:start-outstanding-link */
      SELECT max(expires_at)::text AS expires_at,
             (array_agg(recipient_time_zone ORDER BY created_at)
               FILTER (WHERE recipient_time_zone IS NOT NULL))[1] AS recipient_time_zone
      FROM exomem_invites
      WHERE email_normalized = ${input.emailNormalized}
        AND self_serve
        AND consumed_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      HAVING count(*) > 0
    `;
    const held = outstanding.rows[0] as
      | { expires_at: string; recipient_time_zone: string | null }
      | undefined;
    if (held) {
      // A stored zone came from an earlier request and is kept: this request
      // is unauthenticated and must not change it.
      const timeZone = held.recipient_time_zone ?? input.timeZone;
      const invite = await insertStartLink(tx, {
        emailNormalized: input.emailNormalized,
        link,
        // The database's own text: a JavaScript Date would drop microseconds.
        expiresAt: held.expires_at,
      });
      await enqueueStartLinkEmail(tx, {
        kind: "start",
        emailNormalized: input.emailNormalized,
        timeZone,
        link,
        invite,
      });
      return "reissued";
    }

    if (input.mode === "open") {
      const fits = await cloudAdmissionAllows(tx, { email: input.emailNormalized });
      const waiting = await tx`
        /* exomem:start-anybody-waiting */
        SELECT EXISTS (
          SELECT 1 FROM exomem_waitlist_entries WHERE admitted_at IS NULL
        ) AS waiting
      `;
      if (
        fits &&
        !(waiting.rows[0] as { waiting: boolean }).waiting &&
        (await takeSelfServeAdmission(tx))
      ) {
        const invite = await insertStartLink(tx, {
          emailNormalized: input.emailNormalized,
          link,
          expiresAt: new Date(Date.now() + START_LINK_TTL_MS).toISOString(),
        });
        await enqueueStartLinkEmail(tx, {
          kind: "start",
          emailNormalized: input.emailNormalized,
          timeZone: input.timeZone,
          link,
          invite,
        });
        return "admitted";
      }
    }

    const existing = await tx`
      /* exomem:start-waitlist-entry */
      SELECT id, admitted_at, time_zone
      FROM exomem_waitlist_entries
      WHERE email_normalized = ${input.emailNormalized}
      FOR UPDATE
    `;
    const entry = existing.rows[0] as
      | { id: string; admitted_at: Date | null; time_zone: string | null }
      | undefined;
    let entryId: string;
    // A stored zone came from an earlier request and is kept: this request is
    // unauthenticated and must not change it.
    const timeZone = entry?.time_zone ?? input.timeZone;
    if (entry && entry.admitted_at === null) {
      await tx`
        /* exomem:start-waitlist-keep-place */
        UPDATE exomem_waitlist_entries
        SET updated_at = now()
        WHERE id = ${entry.id}::uuid
      `;
      entryId = entry.id;
    } else {
      if (entry) {
        // Their promotion's start link was used or lapsed: a new entry, with
        // a new arrival time, puts them at the back.
        await tx`DELETE FROM exomem_waitlist_entries WHERE id = ${entry.id}::uuid`;
      }
      const inserted = await tx`
        /* exomem:start-waitlist-join */
        INSERT INTO exomem_waitlist_entries (email_normalized, time_zone)
        VALUES (${input.emailNormalized}, NULL)
        RETURNING id
      `;
      entryId = (inserted.rows[0] as { id: string }).id;
    }
    // One waitlist email per entry: asking again while waiting keeps the
    // place and sends nothing more ("We write again only when a place opens").
    await enqueueExomemEmail(tx, {
      kind: "waitlist",
      dedupeKey: `waitlist:${entryId}`,
      recipient: input.emailNormalized,
      recipientTimeZone: timeZone,
      payload: { version: 1, entryId },
      expiresAt: new Date(Date.now() + WAITLIST_EMAIL_TTL_MS),
    });
    return "waitlisted";
  });
}

export type WaitlistPromotionResult =
  | { status: "not_open"; promoted: null; settled: null }
  | { status: "ran"; promoted: number; settled: number };

/**
 * Promotes waiting people, oldest first, while Cloud has a free slot and the
 * self-serve pace has room. Runs only in `open` mode. Each promotion is its
 * own transaction under the capacity lock: it re-reads the headroom, takes
 * the oldest waiting entry, creates its start link, marks the entry admitted
 * and enqueues the "place opened" email, so a crash between two promotions
 * loses nothing.
 *
 * A waiting address that has since come to own an Exomem (an operator
 * invited it) needs no place. Its entry is settled, by deletion, instead of
 * being promoted into a start link that redemption would refuse. Settling
 * runs once per call, before the promotions and outside the capacity lock:
 * waitlist entries hold no Cloud slot, so the lock does not cover them.
 */
export async function promoteWaitlistedPeople(
  options: {
    maxPromotions?: number;
    mode?: SelfServeAdmissionMode;
    randomBytes?: RandomBytesSource;
  } = {}
): Promise<WaitlistPromotionResult> {
  if ((options.mode ?? selfServeAdmissionMode()) !== "open") {
    return { status: "not_open", promoted: null, settled: null };
  }
  const maxPromotions = Math.max(1, Math.min(options.maxPromotions ?? 20, 100));
  const owners = await executeExomemSql`
    /* exomem:promote-settle-owners */
    DELETE FROM exomem_waitlist_entries AS entry
    USING users
    JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
    WHERE entry.admitted_at IS NULL
      AND users.email = entry.email_normalized
      AND users.deleted_at IS NULL
      AND tenant.status IN ('provisioning', 'active', 'suspended')
      AND tenant.deleted_at IS NULL
    RETURNING entry.id
  `;
  const settled = owners.rows.length;
  let promoted = 0;
  while (promoted < maxPromotions) {
    const link = mintStartLink(options.randomBytes);
    const admitted = await withExomemTransaction(async (tx) => {
      await lockCloudCapacity(tx);
      const oldest = await tx`
        /* exomem:promote-oldest-waiting */
        SELECT id, email_normalized::text AS email_normalized, time_zone
        FROM exomem_waitlist_entries
        WHERE admitted_at IS NULL
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const entry = oldest.rows[0] as
        | { id: string; email_normalized: string; time_zone: string | null }
        | undefined;
      if (!entry) return false;
      if (!(await cloudAdmissionAllows(tx, { email: entry.email_normalized }))) return false;
      if (!(await takeSelfServeAdmission(tx))) return false;
      const invite = await insertStartLink(tx, {
        emailNormalized: entry.email_normalized,
        link,
        expiresAt: new Date(Date.now() + START_LINK_TTL_MS).toISOString(),
      });
      await tx`
        /* exomem:promote-mark-admitted */
        UPDATE exomem_waitlist_entries
        SET admitted_at = now(), admitted_invite_id = ${invite.inviteId}::uuid, updated_at = now()
        WHERE id = ${entry.id}::uuid
      `;
      await enqueueStartLinkEmail(tx, {
        kind: "place_opened",
        emailNormalized: entry.email_normalized,
        timeZone: entry.time_zone,
        link,
        invite,
      });
      return true;
    });
    if (!admitted) break;
    promoted += 1;
  }
  return { status: "ran", promoted, settled };
}

// A person's waitlist entry and unused start links are deleted this long
// after the later of their last request and their last start link's expiry.
// They can ask again and join the back.
const SELF_SERVE_RETENTION_DAYS = 180;

export type SelfServePruneResult = { waitlistEntries: number; startLinks: number };

/**
 * Deletes, in one bounded batch, the self-serve records of people who are
 * not customers: the waitlist entry, waiting or admitted, and every start
 * link that was never used. An address that owns an Exomem keeps them;
 * account deletion removes them. Used start links and operator invitations
 * stay: they record how a customer was admitted.
 *
 * Only an entry updated, or a link expiring, before the cutoff can make its
 * address stale, so the scan starts from those rows through their indexes
 * and each run touches one batch, not every entry.
 */
export async function pruneStaleSelfServeRecords(limit = 500): Promise<SelfServePruneResult> {
  const { rows } = await executeExomemSql`
    /* exomem:prune-stale-self-serve */
    WITH cutoff AS (
      SELECT now() - (${SELF_SERVE_RETENTION_DAYS} * interval '1 day') AS at
    ),
    candidates AS (
      SELECT entry.email_normalized
      FROM exomem_waitlist_entries AS entry
      WHERE entry.updated_at < (SELECT at FROM cutoff)
      UNION ALL
      SELECT link.email_normalized
      FROM exomem_invites AS link
      WHERE link.self_serve
        AND link.consumed_at IS NULL
        AND link.expires_at < (SELECT at FROM cutoff)
    ),
    stale AS (
      SELECT DISTINCT stale_address.email_normalized
      FROM (
        SELECT candidate.email_normalized
        FROM candidates AS candidate
        WHERE NOT EXISTS (
            SELECT 1 FROM exomem_waitlist_entries AS entry
            WHERE entry.email_normalized = candidate.email_normalized
              AND entry.updated_at >= (SELECT at FROM cutoff)
          )
          AND NOT EXISTS (
            SELECT 1 FROM exomem_invites AS link
            WHERE link.email_normalized = candidate.email_normalized
              AND link.self_serve
              AND link.expires_at >= (SELECT at FROM cutoff)
          )
          AND NOT EXISTS (
            SELECT 1
            FROM users
            JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
            WHERE users.email = candidate.email_normalized
              AND users.deleted_at IS NULL
              AND tenant.status IN ('provisioning', 'active', 'suspended')
              AND tenant.deleted_at IS NULL
          )
        LIMIT ${Math.max(1, Math.min(Math.floor(limit), 5_000))}
      ) AS stale_address
    ),
    -- The entry goes in the same statement as the link it may name, so the
    -- link's ON DELETE SET NULL never meets the entry's admitted-pair CHECK.
    -- The repeated cutoff test skips an entry a request updated meanwhile.
    entries AS (
      DELETE FROM exomem_waitlist_entries AS entry
      USING stale
      WHERE entry.email_normalized = stale.email_normalized
        AND entry.updated_at < (SELECT at FROM cutoff)
      RETURNING entry.id
    ),
    links AS (
      DELETE FROM exomem_invites AS link
      USING stale
      WHERE link.email_normalized = stale.email_normalized
        AND link.self_serve
        AND link.consumed_at IS NULL
        AND link.expires_at < (SELECT at FROM cutoff)
      RETURNING link.id
    )
    SELECT (SELECT count(*) FROM entries) AS entries, (SELECT count(*) FROM links) AS links
  `;
  const row = rows[0] as { entries: string; links: string };
  return { waitlistEntries: Number(row.entries), startLinks: Number(row.links) };
}
