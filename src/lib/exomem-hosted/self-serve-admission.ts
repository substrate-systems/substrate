/**
 * Self-serve admission for "Start with your email": a person who owns no
 * Exomem gets a start link while Cloud has a free slot and nobody is waiting,
 * and a waitlist place otherwise. Waiting people are promoted first come,
 * first served when a slot frees. Every decision enqueues its email in the
 * transaction that records it, so the page response never depends on the
 * outcome, and every one queues exactly one.
 */

import { type ExomemThemeChoice } from "@/lib/exomem/theme";

import { createHash } from "node:crypto";
import type { ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { cloudAdmissionAllows, lockCloudCapacity } from "./cloud-capacity";
import { executeExomemSql, takeRateLimit, withExomemTransaction, type ExomemSql } from "./db";
import {
  carryRotatedInvitationLink,
  enqueueExomemEmail,
  invitationEmailInFlight,
  invitationWaitingDedupePrefix,
  type StartLinkPayload,
} from "./email-outbox";
import { healthCanaryAddress } from "./health-canary";
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
// A person who asks again gets one reply per entry or invitation in this window,
// so a repeated request cannot make us mail the same address over and over.
export const REPEAT_REPLY_WINDOW_MS = 15 * 60 * 1000;

function repeatReplyWindow(): number {
  return Math.floor(Date.now() / REPEAT_REPLY_WINDOW_MS);
}

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

export type StartOutcome =
  | "admitted"
  | "reissued"
  | "waitlisted"
  /** The person already waits and keeps their place. */
  | "still_waiting"
  /** An operator invitation to the address is open; its link is replaced and emailed, or is already in flight. */
  | "invitation_waiting";

/** `emailId` is the outbox row this request queued; `null` when its dedupe key already existed. */
export type StartResult = { outcome: StartOutcome; emailId: string | null };

type StartLinkMaterial = { token: string; digest: Buffer };

function mintStartLink(randomBytes?: RandomBytesSource): StartLinkMaterial {
  const token = generateExternalToken(randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw new Error("start link token has no digest");
  return { token, digest };
}

/**
 * Gives an open invitation the link in `payload`: the earlier token stops
 * opening it. Capacity, kind, entitlement and expiry are untouched, so the
 * place the invitation holds is the same place. The invitation's emails that
 * still carry the earlier token cancel themselves at send; the friend
 * reminder is rewritten to carry the new one.
 */
async function rotateInvitationLink(
  tx: ExomemSql,
  payload: StartLinkPayload,
  digest: Buffer
): Promise<void> {
  await tx`
    /* exomem:rotate-invitation-link */
    UPDATE exomem_invites
    SET token_digest = ${digest}
    WHERE id = ${payload.inviteId}::uuid
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
  `;
  await carryRotatedInvitationLink(tx, payload);
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
    emailScheme: ExomemEmailScheme | null;
    themeChoice?: ExomemThemeChoice | null;
    link: StartLinkMaterial;
    invite: { inviteId: string; expiresAt: string };
  }
): Promise<string | null> {
  return enqueueExomemEmail(tx, {
    kind: input.kind,
    dedupeKey: `start:${input.invite.inviteId}`,
    recipient: input.emailNormalized,
    recipientTimeZone: input.timeZone,
    recipientEmailScheme: input.emailScheme,
    recipientThemeChoice: input.themeChoice,
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
 * The address's open operator invitation (not self-serve, unused, unrevoked,
 * unexpired), locked for this transaction; `null` when it has none, and
 * `being_sent` when an email with its current link is under a running send
 * lease. That email works and is the answer, so the caller leaves the link.
 *
 * The locks, in order: a per-invitation advisory lock, the invitation's unsent
 * emails, then the invitation. The emails come before the invitation, as in a
 * send's settlement (its outbox row, then `afterSent` or `afterFailed` on the
 * invitation); the reverse order lets the two wait on each other, and
 * PostgreSQL aborts the settlement of a message the provider already accepted.
 * So the invitation is read unlocked first, and locked after the emails, with
 * its liveness read again.
 */
async function lockOpenInvitation(
  tx: ExomemSql,
  email: string
): Promise<{ id: string; expires_at: Date | string } | "being_sent" | null> {
  const candidate = await tx`
    /* exomem:start-open-invitation */
    SELECT id
    FROM exomem_invites
    WHERE email_normalized = ${email}
      AND NOT self_serve
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const inviteId = (candidate.rows[0] as { id: string } | undefined)?.id;
  if (!inviteId) return null;
  // Requests for one invitation take turns, so the check below reads the email an earlier request
  // queued: a row lock cannot cover a row that is not committed yet. Settlement never takes this
  // lock, so it cannot wait on it.
  await tx`
    /* exomem:serialize-start-requests */
    SELECT pg_advisory_xact_lock(hashtextextended('exomem-start-invitation:' || ${inviteId}::text, 0))
  `;
  if (await invitationEmailInFlight(tx, { inviteId, email })) return "being_sent";
  // Serializes this request with a redemption and with another request's rotation.
  const locked = await tx`
    /* exomem:lock-open-invitation */
    SELECT id, expires_at
    FROM exomem_invites
    WHERE id = ${inviteId}::uuid
      AND NOT self_serve
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
    FOR UPDATE
  `;
  return (locked.rows[0] as { id: string; expires_at: Date | string } | undefined) ?? null;
}

/**
 * The self-serve branch of a start request, for a person who owns no
 * Exomem, in one transaction. Each outcome queues one email:
 *
 * 0. An address with an open operator invitation (not self-serve, unused,
 *    unrevoked, unexpired) gets that invitation again under a new link: the
 *    email carries it, and the link sent earlier stops working. This comes
 *    first, before the capacity lock: the invitation keeps its expiry, kind,
 *    entitlement and place in capacity, so it reads no capacity and makes no
 *    start link and no waitlist place. Anybody can submit any address, so a
 *    stranger can rotate an invitee's link, but only once per 15-minute
 *    window, and the invitee always receives the newest link.
 *
 * The rest runs under the Cloud capacity lock:
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
 *    so asking again never costs them it, and is told so, at most once per
 *    15 minutes. A person whose earlier start link lapsed unused goes to the
 *    back, because they already had a turn.
 */
export async function startSelfServeAtomic(input: {
  emailNormalized: string;
  timeZone: string | null;
  /** Absent is unknown: the emails are dark. */
  emailScheme?: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
  mode: "waitlist" | "open";
  randomBytes?: RandomBytesSource;
}): Promise<StartResult> {
  const link = mintStartLink(input.randomBytes);
  const emailScheme = input.emailScheme ?? null;
  const themeChoice = input.themeChoice ?? "auto";
  // The health canary never holds a Cloud place, whatever the mode and however it asks: it is
  // configuration for a proof, and an address nobody owns must not be handed a slot or a link.
  const isCanary = input.emailNormalized === healthCanaryAddress();
  return withExomemTransaction(async (tx) => {
    const open = await lockOpenInvitation(tx, input.emailNormalized);
    if (open === "being_sent") return { outcome: "invitation_waiting", emailId: null };
    if (open) {
      const payload: StartLinkPayload = {
        version: 1,
        inviteId: open.id,
        token: link.token,
        expiresAt: new Date(open.expires_at).toISOString(),
      };
      const emailId = await enqueueExomemEmail(tx, {
        kind: "invitation_waiting",
        dedupeKey: `${invitationWaitingDedupePrefix(open.id)}${repeatReplyWindow()}`,
        recipient: input.emailNormalized,
        recipientTimeZone: input.timeZone,
        recipientEmailScheme: emailScheme,
        recipientThemeChoice: themeChoice,
        payload,
        expiresAt: new Date(Date.now() + WAITLIST_EMAIL_TTL_MS),
      });
      // A repeat inside the window queued nothing, and the link its email
      // carries is still the current one: rotating now would kill it.
      if (emailId) await rotateInvitationLink(tx, payload, link.digest);
      return { outcome: "invitation_waiting", emailId };
    }

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
    const held = isCanary
      ? undefined
      : (outstanding.rows[0] as
          | { expires_at: string; recipient_time_zone: string | null }
          | undefined);
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
      return {
        outcome: "reissued",
        emailId: await enqueueStartLinkEmail(tx, {
          kind: "start",
          emailNormalized: input.emailNormalized,
          timeZone,
          emailScheme,
          themeChoice,
          link,
          invite,
        }),
      };
    }

    if (input.mode === "open" && !isCanary) {
      const fits = await cloudAdmissionAllows(tx, { email: input.emailNormalized });
      // The health canary waits for good and takes no place (see health-canary.ts), so it is no queue to overtake.
      const waiting = await tx`
        /* exomem:start-anybody-waiting */
        SELECT EXISTS (
          SELECT 1 FROM exomem_waitlist_entries
          WHERE admitted_at IS NULL AND email_normalized IS DISTINCT FROM ${healthCanaryAddress()}::citext
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
        return {
          outcome: "admitted",
          emailId: await enqueueStartLinkEmail(tx, {
            kind: "start",
            emailNormalized: input.emailNormalized,
            timeZone: input.timeZone,
            emailScheme,
            themeChoice,
            link,
            invite,
          }),
        };
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
    let alreadyWaiting = false;
    // A stored zone came from an earlier request and is kept: this request is
    // unauthenticated and must not change it.
    const timeZone = entry?.time_zone ?? input.timeZone;
    // The scheme is stored, and the latest request's wins: it changes only how
    // the email looks, and the place-opened email has no other source for it.
    if (entry && entry.admitted_at === null) {
      await tx`
        /* exomem:start-waitlist-keep-place */
        UPDATE exomem_waitlist_entries
        SET email_scheme = COALESCE(${emailScheme}, email_scheme), theme_choice = ${themeChoice}, updated_at = now()
        WHERE id = ${entry.id}::uuid
      `;
      entryId = entry.id;
      alreadyWaiting = true;
    } else {
      if (entry) {
        // Their promotion's start link was used or lapsed: a new entry, with
        // a new arrival time, puts them at the back.
        await tx`DELETE FROM exomem_waitlist_entries WHERE id = ${entry.id}::uuid`;
      }
      const inserted = await tx`
        /* exomem:start-waitlist-join */
        INSERT INTO exomem_waitlist_entries (email_normalized, time_zone, email_scheme, theme_choice)
        VALUES (${input.emailNormalized}, NULL, ${emailScheme}, ${themeChoice})
        RETURNING id
      `;
      entryId = (inserted.rows[0] as { id: string }).id;
    }
    const waitlistEmail = {
      recipient: input.emailNormalized,
      recipientTimeZone: timeZone,
      recipientEmailScheme: emailScheme,
      recipientThemeChoice: themeChoice,
      payload: { version: 1 as const, entryId },
      expiresAt: new Date(Date.now() + WAITLIST_EMAIL_TTL_MS),
    };
    // One waitlist email per entry, and one "still on the list" reply per
    // entry for each window in which they ask again.
    return alreadyWaiting
      ? {
          outcome: "still_waiting",
          emailId: await enqueueExomemEmail(tx, {
            ...waitlistEmail,
            kind: "waitlist_still_waiting",
            dedupeKey: `waitlist-still-waiting:${entryId}:${repeatReplyWindow()}`,
          }),
        }
      : {
          outcome: "waitlisted",
          emailId: await enqueueExomemEmail(tx, {
            ...waitlistEmail,
            kind: "waitlist",
            dedupeKey: `waitlist:${entryId}`,
          }),
        };
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
  // The health canary waits for good: promoting it would hand a Cloud slot to an address nobody owns.
  const canary = healthCanaryAddress();
  const owners = await executeExomemSql`
    /* exomem:promote-settle-owners */
    DELETE FROM exomem_waitlist_entries AS entry
    USING exomem_users
    JOIN exomem_tenants AS tenant ON tenant.owner_user_id = exomem_users.id
    WHERE entry.admitted_at IS NULL
      AND exomem_users.email = entry.email_normalized
      AND exomem_users.deleted_at IS NULL
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
        SELECT id, email_normalized::text AS email_normalized, time_zone, email_scheme, theme_choice
        FROM exomem_waitlist_entries
        WHERE admitted_at IS NULL AND email_normalized IS DISTINCT FROM ${canary}::citext
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;
      const entry = oldest.rows[0] as
        | {
            id: string;
            email_normalized: string;
            time_zone: string | null;
            theme_choice?: ExomemThemeChoice | null;
            email_scheme: ExomemEmailScheme | null;
          }
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
        emailScheme: entry.email_scheme,
        themeChoice: entry.theme_choice,
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
            FROM exomem_users
            JOIN exomem_tenants AS tenant ON tenant.owner_user_id = exomem_users.id
            WHERE exomem_users.email = candidate.email_normalized
              AND exomem_users.deleted_at IS NULL
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
