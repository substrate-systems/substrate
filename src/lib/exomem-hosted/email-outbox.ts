/**
 * The Exomem email outbox (migration 0063).
 *
 * An email is enqueued in the same transaction as the fact it announces, under
 * a unique dedupe key, so "sent once" is a database constraint rather than a
 * hope. The `exomem-access-delivery` cron drains it: each row is claimed
 * under a lease, its kind re-checks that the fact still holds (or the row is
 * `cancelled`), and it is rendered at send time in the recipient's time zone.
 * Delivery is at least once: a worker that dies after the provider accepted
 * the email but before it recorded `sent` leaves the lease to expire, and the
 * next worker sends again.
 *
 * Each kind is one entry in `EXOMEM_EMAILS`, plus its name in the
 * `exomem_email_outbox_kind_check` constraint.
 */

import { randomUUID } from "node:crypto";
import { sendTransactionalEmail, type SendTransactionalEmailResult } from "@/lib/brevo";
import {
  renderExomemHoldReminderEmail,
  renderExomemInviteEmail,
  renderExomemPlaceOpenedEmail,
  renderExomemWaitlistEmail,
  renderExomemWelcomeEmail,
  type RenderedExomemAccessEmail,
} from "@/lib/email-templates/exomem-access";
import {
  renderExomemDeletedEmail,
  renderExomemDeletionReminderEmail,
  renderExomemPaymentFailedEmail,
  renderExomemReadyEmail,
  renderExomemSubscriptionEndedEmail,
} from "@/lib/email-templates/exomem-lifecycle";
import {
  renderExomemCoveredInvitationEmail,
  renderExomemFriendInvitationEmail,
  renderExomemInvitationEndedEmail,
  renderExomemInvitationReminderEmail,
  renderExomemInvitationUsedEmail,
} from "@/lib/email-templates/exomem-invites";
import { EXOMEM_SENDER } from "@/lib/exomem-hosted/mail-sender";
import { exomemPaddleDunningDays, loadExomemAccountView } from "./account-view";
import { cloudCancelledKeptUntil } from "./cloud-lifecycle";
import { cloudExportsEnabled } from "./cloud-exports";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { FIRST_PAYMENT_SOURCE_STATES } from "./entitlements";
import { deletionReminderAt, enqueueReadyEmails } from "./lifecycle-emails";
import type { ExomemInviteKind } from "./invitation-contract";
import { CURRENCY_CODE, MONEY_MINOR_UNITS, type ExomemMoney } from "@/lib/exomem/money";
import {
  exomemPublicBaseUrlFromEnv,
  exomemPublicFragmentUrl,
  parseExomemPublicBaseUrl,
} from "./public-origin";
import { decryptSecret, encryptSecret, tokenDigest, type SecretEnvelope } from "./security";

const MAX_EMAILS_PER_TICK = 20;
const LEASE_SECONDS = 60;
// Retries back off 1, 2, 4 … 60 minutes and continue until the email's own
// deadline (48 hours for a start link), so a provider outage costs nobody
// their place. An email with no deadline stops after this many attempts.
const MAX_ATTEMPTS_WITHOUT_DEADLINE = 10;
const MAX_BACKOFF_MINUTES = 60;
// Settled rows keep their recipient this long, for support questions.
const SETTLED_RECIPIENT_RETENTION_DAYS = 30;
// Email 07 looks again this often for cellctl to finish a deletion.
const DELETED_RECHECK_MINUTES = 5;

type EmailRenderInput<P, C> = {
  payload: P;
  context: C;
  /** The zone of the person the email goes to, as `addressee` or the row gives it. */
  timeZone: string | null;
  now: Date;
  publicBaseUrl: string;
};

/** An account owner's address and time zone, as the database holds them now. */
export type ExomemEmailAddressee = { email: string; timeZone: string | null };

/**
 * The fact an email announces will hold later but does not yet: the row waits
 * until `until`. Waiting is not a delivery attempt, so it counts no attempt.
 * A deadline still applies while the row waits: the claim fails a row whose
 * `expires_at` has passed before it looks at `NotYet`.
 */
class NotYet {
  constructor(readonly until: Date) {}
}

type EmailDefinition<P, C> = {
  /** Checks the decrypted payload's shape. `null` fails the row. */
  readPayload: (value: Record<string, unknown>) => P | null;
  /**
   * Re-checks, inside the claim's transaction, that the fact this email
   * announces still holds. `null` cancels the row, and `NotYet` puts it back
   * until then. Any other value is passed to `render`.
   */
  stillHolds: (tx: ExomemSql, payload: P) => Promise<C | NotYet | null>;
  /**
   * For an email to an account's owner: where it goes, read by `stillHolds`,
   * so it reaches the owner's address and zone at send time. Without it the
   * email goes to the row's recipient: a start link to the address that asked
   * for it, and email 07 to the owner's address when the Exomem was deleted.
   */
  addressee?: (context: C) => ExomemEmailAddressee;
  /**
   * Renders the email after the claim, outside its transaction, so it may
   * wait on a fact the claim must not hold its lock for, such as Paddle's price.
   */
  render: (
    input: EmailRenderInput<P, C>
  ) => RenderedExomemAccessEmail | Promise<RenderedExomemAccessEmail>;
  afterSent?: (tx: ExomemSql, payload: P) => Promise<void>;
  /** `errorCode` is the one the row records, so a linked record can name the same cause. */
  afterFailed?: (tx: ExomemSql, payload: P, errorCode: string) => Promise<void>;
  /**
   * Claimed only while no other kind is ready, for an email that anybody can
   * cause for any address, so a flood of it never delays anyone else's mail.
   */
  claimedLast?: true;
  /**
   * A provider refusal fails it at once instead of retrying it until its
   * deadline. Only for a kind without `afterFailed`, whose failure takes
   * nothing from anyone; the drain ignores the flag on any other kind.
   */
  failsWhenRefused?: true;
};

function defineEmail<P, C>(definition: EmailDefinition<P, C>): EmailDefinition<P, C> {
  return definition;
}

// Format checks on ids before they reach a `::uuid` cast: a malformed id
// would abort the claim's transaction on every tick instead of failing one row.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The cell id shape of migration 0056's `exomem_cloud_cells_cell_id_check`.
const CELL_ID = /^[a-z2-7]{16}$/;

function readFields<K extends string>(
  value: Record<string, unknown>,
  keys: readonly K[]
): Record<K, string> | null {
  if (value.version !== 1) return null;
  if (Object.keys(value).sort().join(",") !== [...keys, "version"].sort().join(",")) return null;
  const fields = {} as Record<K, string>;
  for (const key of keys) {
    const field = value[key];
    if (typeof field !== "string" || field.length === 0) return null;
    fields[key] = field;
  }
  return fields;
}

export type StartLinkPayload = {
  version: 1;
  inviteId: string;
  token: string;
  expiresAt: string;
};

export type WaitlistPayload = { version: 1; entryId: string };

export type HoldReminderPayload = {
  version: 1;
  cellId: string;
  holdEndsAt: string;
  inviterName: string | null;
};

function readStartLinkPayload(value: Record<string, unknown>): StartLinkPayload | null {
  const fields = readFields(value, ["inviteId", "token", "expiresAt"] as const);
  if (!fields || !UUID.test(fields.inviteId) || !Number.isFinite(Date.parse(fields.expiresAt))) {
    return null;
  }
  return { version: 1, ...fields };
}

async function startLinkStillUsable(
  tx: ExomemSql,
  payload: StartLinkPayload
): Promise<true | null> {
  const digest = tokenDigest(payload.token);
  if (!digest) return null;
  const { rows } = await tx`
    /* exomem:email-start-link-usable */
    SELECT 1 FROM exomem_invites
    WHERE id = ${payload.inviteId}::uuid
      AND token_digest = ${digest}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
  `;
  return rows.length === 1 ? true : null;
}

async function markStartLinkDelivered(tx: ExomemSql, payload: StartLinkPayload): Promise<void> {
  await tx`
    /* exomem:email-start-link-delivered */
    UPDATE exomem_invites
    SET delivery_state = 'sent',
        delivery_attempts = delivery_attempts + 1,
        delivered_at = now(),
        delivery_error_code = NULL
    WHERE id = ${payload.inviteId}::uuid AND consumed_at IS NULL AND revoked_at IS NULL
  `;
}

/**
 * The token exists only in this email, so an undelivered start link is a
 * promise of capacity that nobody can use. Revoking it gives the place back.
 * A promoted waitlist entry stays admitted: re-queuing it would promote the
 * same unreachable address again and again at the head of the queue.
 */
async function revokeUndeliveredStartLink(
  tx: ExomemSql,
  payload: StartLinkPayload,
  errorCode: string
): Promise<void> {
  await tx`
    /* exomem:email-start-link-undelivered */
    UPDATE exomem_invites
    SET delivery_state = 'failed',
        delivery_error_code = ${errorCode},
        revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${payload.inviteId}::uuid AND consumed_at IS NULL
  `;
}

function startLinkUrl(input: EmailRenderInput<StartLinkPayload, true>): string {
  return exomemPublicFragmentUrl(input.publicBaseUrl, "/exomem/invite", input.payload.token);
}

type FieldShape = "uuid" | "cellId" | "instant" | "boolean";
type FieldValue<F extends FieldShape> = F extends "boolean" ? boolean : string;

/**
 * Reads a version-1 payload with exactly these fields, each checked for its
 * shape. `null` fails the row.
 */
function readShape<S extends Record<string, FieldShape>>(
  value: Record<string, unknown>,
  shape: S
): ({ version: 1 } & { [K in keyof S]: FieldValue<S[K]> }) | null {
  if (value.version !== 1) return null;
  const keys = Object.keys(shape);
  if (Object.keys(value).sort().join(",") !== [...keys, "version"].sort().join(",")) return null;
  for (const key of keys) {
    const field = value[key];
    const ok =
      shape[key] === "boolean"
        ? typeof field === "boolean"
        : typeof field === "string" &&
          (shape[key] === "uuid"
            ? UUID.test(field)
            : shape[key] === "cellId"
              ? CELL_ID.test(field)
              : Number.isFinite(Date.parse(field)));
    if (!ok) return null;
  }
  return value as { version: 1 } & { [K in keyof S]: FieldValue<S[K]> };
}

export type ReadyPayload = { version: 1; cellId: string };
export type PaymentFailedPayload = { version: 1; tenantId: string; graceStartedAt: string };
/** `endedAt` is the cell's cancellation claim: it names one ended period. */
export type SubscriptionEndedPayload = {
  version: 1;
  cellId: string;
  endedAt: string;
  reminderScheduled: boolean;
};
export type DeletionReminderPayload = { version: 1; cellId: string; endedAt: string };
export type DeletedPayload = { version: 1; tenantId: string; deletedAt: string };

function homeUrl(publicBaseUrl: string): string {
  return new URL("/exomem/home", `${publicBaseUrl}/`).toString();
}

function supportUrl(publicBaseUrl: string): string {
  return new URL("/exomem/support", `${publicBaseUrl}/`).toString();
}

/** Home's export, which an ended owner opens for a copy; null while Home offers no export. */
function exportUrl(publicBaseUrl: string): string | null {
  return cloudExportsEnabled() ? homeUrl(publicBaseUrl) : null;
}

type OwnerRow = { owner_email: string; time_zone: string | null };

function ownerOf(row: OwnerRow): ExomemEmailAddressee {
  return { email: row.owner_email, timeZone: row.time_zone };
}

/**
 * Email 03's plan facts, as Home shows them (loadExomemAccountView): the next
 * payment's amount as Paddle reports it, and the inviter whose friend price
 * is on the plan. Each is `null` when unknown, and the email leaves it out.
 */
async function readyPlan(account: {
  userId: string;
  tenantId: string;
}): Promise<{ price: ExomemMoney | null; friendInviterName: string | null }> {
  try {
    const view = await loadExomemAccountView({ ...account, reviewerCredentialId: null });
    return {
      price: view.nextPaymentAmount.value,
      friendInviterName: view.plan.friendPrice.applied ? view.plan.friendPrice.inviterName : null,
    };
  } catch {
    console.error("exomem: ready email plan facts unavailable");
    return { price: null, friendInviterName: null };
  }
}

type EndedContext = { owner: ExomemEmailAddressee; keptUntil: Date; checkedAt: Date };

/**
 * An ended period still holds while its cell is read-only under the same
 * cancellation claim, the subscription is still cancelled, no deletion has
 * started, and the kept window, from the entitlement's current
 * `source_occurred_at`, is still open. `checkedAt` is the database's clock,
 * the one the outbox schedules by.
 */
async function endedPeriodStillHolds(
  tx: ExomemSql,
  payload: { cellId: string; endedAt: string }
): Promise<EndedContext | null> {
  const { rows } = await tx`
    /* exomem:email-ended-period-still-holds */
    SELECT owner.email::text AS owner_email, tenant.time_zone,
           entitlement.source_occurred_at, now() AS checked_at
    FROM exomem_cloud_cells AS cell
    JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
    JOIN users AS owner ON owner.id = tenant.owner_user_id
    JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
    WHERE cell.cell_id = ${payload.cellId}
      AND cell.desired_state = 'read_only'
      AND cell.cancellation_notice_sent_at = ${payload.endedAt}::timestamptz
      AND entitlement.source = 'paddle'
      AND entitlement.source_state = 'cancelled'
      AND entitlement.manual_suspended_at IS NULL
      AND entitlement.source_occurred_at IS NOT NULL
      AND tenant.status NOT IN ('deletion_pending', 'deleted')
  `;
  const row = rows[0] as
    | (OwnerRow & { source_occurred_at: Date | string; checked_at: Date | string })
    | undefined;
  if (!row) return null;
  const keptUntil = cloudCancelledKeptUntil(new Date(row.source_occurred_at));
  const checkedAt = new Date(row.checked_at);
  return keptUntil > checkedAt ? { owner: ownerOf(row), keptUntil, checkedAt } : null;
}

/** The invitee reminder (email 11) goes this many days before an invitation ends. */
export const INVITATION_REMINDER_LEAD_DAYS = 3;

export type FriendInvitationPayload = StartLinkPayload & {
  usualAmount: string;
  usualCurrency: string;
  friendAmount: string;
  friendCurrency: string;
};

export type InvitationNoticePayload = { version: 1; inviteId: string };

function readFriendInvitationPayload(
  value: Record<string, unknown>
): FriendInvitationPayload | null {
  const fields = readFields(value, [
    "inviteId",
    "token",
    "expiresAt",
    "usualAmount",
    "usualCurrency",
    "friendAmount",
    "friendCurrency",
  ] as const);
  if (
    !fields ||
    !UUID.test(fields.inviteId) ||
    !Number.isFinite(Date.parse(fields.expiresAt)) ||
    !MONEY_MINOR_UNITS.test(fields.usualAmount) ||
    !MONEY_MINOR_UNITS.test(fields.friendAmount) ||
    !CURRENCY_CODE.test(fields.usualCurrency) ||
    !CURRENCY_CODE.test(fields.friendCurrency)
  ) {
    return null;
  }
  return { version: 1, ...fields };
}

function readInvitationNoticePayload(
  value: Record<string, unknown>
): InvitationNoticePayload | null {
  const fields = readFields(value, ["inviteId"] as const);
  return fields && UUID.test(fields.inviteId) ? { version: 1, ...fields } : null;
}

type UsableInvitation = {
  kind: ExomemInviteKind;
  email: string;
  inviterName: string | null;
  note: string | null;
  /** The invitee's, when their address already has an Exomem account. */
  timeZone: string | null;
};

/**
 * The time zone the Exomem account at this address last reported, or null
 * when none is known; the email then labels its dates UTC. Read at send
 * time, so a zone reported after the email was queued still counts.
 */
async function accountTimeZone(tx: ExomemSql, email: string): Promise<string | null> {
  const { rows } = await tx`
    /* exomem:email-account-time-zone */
    SELECT tenant.time_zone
    FROM users
    JOIN exomem_tenants AS tenant ON tenant.owner_user_id = users.id
    WHERE users.email = ${email}
      AND users.deleted_at IS NULL
      AND tenant.time_zone IS NOT NULL
    ORDER BY tenant.updated_at DESC
    LIMIT 1
  `;
  return (rows[0] as { time_zone: string } | undefined)?.time_zone ?? null;
}

/**
 * The invitation behind an invitation email, while its token can still be
 * used. Names and the note are read here, not stored in the payload, so an
 * account deletion that clears them also stops them being sent.
 */
async function usableInvitation(
  tx: ExomemSql,
  payload: StartLinkPayload
): Promise<UsableInvitation | null> {
  const digest = tokenDigest(payload.token);
  if (!digest) return null;
  const { rows } = await tx`
    /* exomem:email-invitation-usable */
    SELECT kind, email_normalized::text AS email, inviter_name, note
    FROM exomem_invites
    WHERE id = ${payload.inviteId}::uuid
      AND token_digest = ${digest}
      AND consumed_at IS NULL
      AND revoked_at IS NULL
      AND expires_at > now()
  `;
  const row = rows[0] as
    | {
        kind: UsableInvitation["kind"];
        email: string;
        inviter_name: string | null;
        note: string | null;
      }
    | undefined;
  if (!row) return null;
  return {
    kind: row.kind,
    email: row.email,
    inviterName: row.inviter_name,
    note: row.note,
    timeZone: await accountTimeZone(tx, row.email),
  };
}

/** A friend or covered invitation's email names the inviter; without the name it is not sent. */
async function namedInvitation(
  tx: ExomemSql,
  payload: StartLinkPayload,
  kind: "friend" | "covered"
): Promise<(UsableInvitation & { inviterName: string }) | null> {
  const invitation = await usableInvitation(tx, payload);
  return invitation?.kind === kind && invitation.inviterName
    ? { ...invitation, inviterName: invitation.inviterName }
    : null;
}

function invitationUrl(input: { publicBaseUrl: string; payload: StartLinkPayload }): string {
  return exomemPublicFragmentUrl(input.publicBaseUrl, "/exomem/invite", input.payload.token);
}

const EXOMEM_EMAILS = {
  /** Email 01w: a start link from "Start with your email", or a re-sent one. */
  start: defineEmail({
    readPayload: readStartLinkPayload,
    stillHolds: startLinkStillUsable,
    render: (input) =>
      renderExomemWelcomeEmail({
        accessUrl: startLinkUrl(input),
        expiresAt: new Date(input.payload.expiresAt),
        now: input.now,
        timeZone: input.timeZone,
      }),
    afterSent: markStartLinkDelivered,
    afterFailed: revokeUndeliveredStartLink,
  }),
  /** A waiting person's place opened: their start link. */
  place_opened: defineEmail({
    readPayload: readStartLinkPayload,
    stillHolds: startLinkStillUsable,
    render: (input) =>
      renderExomemPlaceOpenedEmail({
        accessUrl: startLinkUrl(input),
        expiresAt: new Date(input.payload.expiresAt),
        timeZone: input.timeZone,
      }),
    afterSent: markStartLinkDelivered,
    afterFailed: revokeUndeliveredStartLink,
  }),
  /** A person joined the waitlist. It holds while they still wait. */
  waitlist: defineEmail({
    readPayload: (value): WaitlistPayload | null => {
      const fields = readFields(value, ["entryId"] as const);
      return fields && UUID.test(fields.entryId) ? { version: 1, ...fields } : null;
    },
    stillHolds: async (tx, payload): Promise<true | null> => {
      const { rows } = await tx`
        /* exomem:email-waitlist-still-waiting */
        SELECT 1 FROM exomem_waitlist_entries
        WHERE id = ${payload.entryId}::uuid AND admitted_at IS NULL
      `;
      return rows.length === 1 ? true : null;
    },
    render: () => renderExomemWaitlistEmail(),
    claimedLast: true,
    failsWhenRefused: true,
  }),
  /**
   * Email 18: two days before an unpaid hold ends. It holds only while the
   * cell is still stopped and the tenant has not paid for the first time.
   * It names the inviter from the invitation that admitted the tenant, read
   * when it is sent, so an inviter's account deletion also removes the name.
   */
  hold_reminder: defineEmail({
    readPayload: (value): HoldReminderPayload | null => {
      const { inviterName, ...rest } = value;
      if (!("inviterName" in value)) return null;
      if (inviterName !== null && (typeof inviterName !== "string" || inviterName.length === 0)) {
        return null;
      }
      const fields = readFields(rest, ["cellId", "holdEndsAt"] as const);
      if (
        !fields ||
        !CELL_ID.test(fields.cellId) ||
        !Number.isFinite(Date.parse(fields.holdEndsAt))
      ) {
        return null;
      }
      return { version: 1, ...fields, inviterName };
    },
    stillHolds: async (
      tx,
      payload
    ): Promise<{ owner: ExomemEmailAddressee; inviterName: string | null } | null> => {
      const { rows } = await tx`
        /* exomem:email-hold-reminder-still-unpaid */
        SELECT owner.email::text AS owner_email, tenant.time_zone,
               (
                 SELECT invite.inviter_name
                 FROM exomem_invites AS invite
                 WHERE invite.redeemed_tenant_id = tenant.id AND invite.inviter_name IS NOT NULL
                 ORDER BY invite.consumed_at DESC
                 LIMIT 1
               ) AS inviter_name
        FROM exomem_cloud_cells AS cell
        JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
        JOIN users AS owner ON owner.id = tenant.owner_user_id
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
        WHERE cell.cell_id = ${payload.cellId}
          AND cell.desired_state = 'stopped'
          AND entitlement.source = 'paddle'
          AND entitlement.source_state = ANY(${[...FIRST_PAYMENT_SOURCE_STATES]}::text[])
      `;
      const row = rows[0] as (OwnerRow & { inviter_name: string | null }) | undefined;
      return row ? { owner: ownerOf(row), inviterName: row.inviter_name } : null;
    },
    addressee: (context) => context.owner,
    render: ({ payload, context, timeZone, publicBaseUrl }) =>
      renderExomemHoldReminderEmail({
        setupUrl: new URL("/exomem/setup", `${publicBaseUrl}/`).toString(),
        holdEndsAt: new Date(payload.holdEndsAt),
        inviterName: context.inviterName,
        timeZone,
      }),
  }),
  /**
   * Email 03: the first time an admitted cell is ready. It holds while the
   * cell is still running and ready, and never for a marketplace reviewer's
   * tenant.
   */
  ready: defineEmail({
    readPayload: (value): ReadyPayload | null => readShape(value, { cellId: "cellId" }),
    stillHolds: async (
      tx,
      payload
    ): Promise<{
      owner: ExomemEmailAddressee;
      account: { userId: string; tenantId: string };
      covered: boolean;
      nextPaymentAt: Date | null;
      connected: boolean;
    } | null> => {
      const { rows } = await tx`
        /* exomem:email-ready-still-ready */
        SELECT owner.email::text AS owner_email,
               owner.id AS owner_user_id,
               tenant.id AS tenant_id,
               tenant.time_zone,
               entitlement.source,
               entitlement.provider_next_billed_at,
               EXISTS (
                 SELECT 1 FROM exomem_oauth_grants AS grant_row
                 WHERE grant_row.tenant_id = cell.tenant_id AND grant_row.revoked_at IS NULL
               ) AS connected
        FROM exomem_cloud_cells AS cell
        JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
        JOIN users AS owner ON owner.id = tenant.owner_user_id
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
        WHERE cell.cell_id = ${payload.cellId}
          AND cell.ready
          AND cell.desired_state = 'running'
          AND cell.observed_state = 'running'
          AND tenant.status = 'active'
          AND NOT tenant.marketplace_reviewer_purpose
      `;
      const row = rows[0] as
        | (OwnerRow & {
            owner_user_id: string;
            tenant_id: string;
            source: string;
            provider_next_billed_at: Date | string | null;
            connected: boolean;
          })
        | undefined;
      if (!row) return null;
      return {
        owner: ownerOf(row),
        account: { userId: row.owner_user_id, tenantId: row.tenant_id },
        covered: row.source === "complimentary",
        nextPaymentAt: row.provider_next_billed_at ? new Date(row.provider_next_billed_at) : null,
        connected: row.connected,
      };
    },
    addressee: (context) => context.owner,
    render: async ({ context, timeZone, publicBaseUrl }) =>
      renderExomemReadyEmail({
        homeUrl: homeUrl(publicBaseUrl),
        // No name is stored for an owner yet.
        recipientName: null,
        connected: context.connected,
        billing: context.covered
          ? null
          : { ...(await readyPlan(context.account)), nextPaymentAt: context.nextPaymentAt },
        timeZone,
      }),
  }),
  /**
   * Email 04: the move into past due. It holds while the same past-due period
   * is still open and no deletion has started.
   */
  payment_failed: defineEmail({
    readPayload: (value): PaymentFailedPayload | null =>
      readShape(value, { tenantId: "uuid", graceStartedAt: "instant" }),
    stillHolds: async (tx, payload): Promise<{ owner: ExomemEmailAddressee } | null> => {
      const { rows } = await tx`
        /* exomem:email-payment-failed-still-past-due */
        SELECT owner.email::text AS owner_email, tenant.time_zone
        FROM exomem_entitlements AS entitlement
        JOIN exomem_tenants AS tenant ON tenant.id = entitlement.tenant_id
        JOIN users AS owner ON owner.id = tenant.owner_user_id
        WHERE entitlement.tenant_id = ${payload.tenantId}::uuid
          AND entitlement.source = 'paddle'
          AND entitlement.source_state = 'past_due'
          AND entitlement.grace_started_at = ${payload.graceStartedAt}::timestamptz
          AND tenant.status NOT IN ('deletion_pending', 'deleted')
      `;
      const row = rows[0] as OwnerRow | undefined;
      return row ? { owner: ownerOf(row) } : null;
    },
    addressee: (context) => context.owner,
    render: ({ payload, timeZone, publicBaseUrl }) => {
      const days = exomemPaddleDunningDays();
      return renderExomemPaymentFailedEmail({
        billingUrl: homeUrl(publicBaseUrl),
        readOnlyUntil:
          days.value === null
            ? null
            : new Date(Date.parse(payload.graceStartedAt) + days.value * 86_400_000),
        timeZone,
      });
    },
  }),
  /** Email 05: the subscription ended. It holds while that ended period does. */
  subscription_ended: defineEmail({
    readPayload: (value): SubscriptionEndedPayload | null =>
      readShape(value, { cellId: "cellId", endedAt: "instant", reminderScheduled: "boolean" }),
    stillHolds: endedPeriodStillHolds,
    addressee: (context) => context.owner,
    render: ({ payload, context, timeZone, now, publicBaseUrl }) =>
      renderExomemSubscriptionEndedEmail({
        exportUrl: exportUrl(publicBaseUrl),
        supportUrl: supportUrl(publicBaseUrl),
        resubscribeUrl: homeUrl(publicBaseUrl),
        keptUntil: context.keptUntil,
        now,
        reminderScheduled: payload.reminderScheduled,
        timeZone,
      }),
  }),
  /**
   * Email 06: a week before an ended Exomem is deleted. The week is counted
   * from the current kept-until date, which a later provider event can move:
   * a reminder that comes due early waits for it.
   */
  deletion_reminder: defineEmail({
    readPayload: (value): DeletionReminderPayload | null =>
      readShape(value, { cellId: "cellId", endedAt: "instant" }),
    stillHolds: async (tx, payload) => {
      const period = await endedPeriodStillHolds(tx, payload);
      if (!period) return null;
      const remindAt = deletionReminderAt(period.keptUntil);
      return period.checkedAt < remindAt ? new NotYet(remindAt) : period;
    },
    addressee: (context) => context.owner,
    render: ({ context, timeZone, now, publicBaseUrl }) =>
      renderExomemDeletionReminderEmail({
        exportUrl: exportUrl(publicBaseUrl),
        supportUrl: supportUrl(publicBaseUrl),
        resubscribeUrl: homeUrl(publicBaseUrl),
        keptUntil: context.keptUntil,
        now,
        timeZone,
      }),
  }),
  /**
   * Email 07: the Exomem was deleted. It holds while the tenant is still
   * deleted by this deletion, the one whose `deleted_at` it names: a
   * re-admission, or a later deletion, cancels it. It says the vault, its
   * backups and its keys are gone, so it waits, without a deadline, until
   * cellctl has deleted every cell of the tenant
   * (`exomem_cloud_cell_deletion_finished`, migration 0068). The date it
   * gives is when cellctl finished: cellctl stops observing a deleted cell,
   * so the latest `observed_at` of the tenant's cells is that moment.
   */
  deleted: defineEmail({
    readPayload: (value): DeletedPayload | null =>
      readShape(value, { tenantId: "uuid", deletedAt: "instant" }),
    stillHolds: async (tx, payload): Promise<{ finishedAt: Date } | NotYet | null> => {
      const { rows } = await tx`
        /* exomem:email-deleted-still-deleted */
        SELECT count(*) FILTER (
                 WHERE NOT exomem_cloud_cell_deletion_finished(cell) OR cell.observed_at IS NULL
               )::int AS unfinished,
               max(cell.observed_at) AS finished_at,
               now() + (${DELETED_RECHECK_MINUTES} * interval '1 minute') AS recheck_at
        FROM exomem_tenants AS tenant
        JOIN exomem_cloud_cells AS cell ON cell.tenant_id = tenant.id
        WHERE tenant.id = ${payload.tenantId}::uuid
          AND tenant.status = 'deleted'
          AND tenant.deleted_at = ${payload.deletedAt}::timestamptz
        GROUP BY tenant.id
      `;
      const row = rows[0] as
        | { unfinished: number; finished_at: Date | string | null; recheck_at: Date | string }
        | undefined;
      if (!row) return null;
      if (row.unfinished > 0 || row.finished_at === null)
        return new NotYet(new Date(row.recheck_at));
      return { finishedAt: new Date(row.finished_at) };
    },
    render: ({ context, timeZone, now }) =>
      renderExomemDeletedEmail({ deletedAt: context.finishedAt, now, timeZone }),
  }),
  /** Email 02: a standard operator invitation. */
  invitation: defineEmail({
    readPayload: readStartLinkPayload,
    stillHolds: async (tx, payload) => {
      const invitation = await usableInvitation(tx, payload);
      return invitation?.kind === "standard" ? invitation : null;
    },
    render: (input) =>
      renderExomemInviteEmail({
        accessUrl: invitationUrl(input),
        expiresAt: new Date(input.payload.expiresAt),
        email: input.context.email,
        now: input.now,
        timeZone: input.context.timeZone ?? input.timeZone,
      }),
    afterSent: markStartLinkDelivered,
    afterFailed: revokeUndeliveredStartLink,
  }),
  /** Email 09: a friend invitation, with the prices Paddle previewed when it was issued. */
  friend_invitation: defineEmail({
    readPayload: readFriendInvitationPayload,
    stillHolds: (tx, payload) => namedInvitation(tx, payload, "friend"),
    render: ({ payload, context, timeZone, publicBaseUrl }) =>
      renderExomemFriendInvitationEmail({
        acceptUrl: invitationUrl({ publicBaseUrl, payload }),
        inviterName: context.inviterName,
        note: context.note,
        inviteeEmail: context.email,
        expiresAt: new Date(payload.expiresAt),
        timeZone: context.timeZone ?? timeZone,
        usualPrice: { amount: payload.usualAmount, currencyCode: payload.usualCurrency },
        friendPrice: { amount: payload.friendAmount, currencyCode: payload.friendCurrency },
      }),
    afterSent: markStartLinkDelivered,
    afterFailed: revokeUndeliveredStartLink,
  }),
  /** Email 10: a covered (complimentary) invitation. */
  covered_invitation: defineEmail({
    readPayload: readStartLinkPayload,
    stillHolds: (tx, payload) => namedInvitation(tx, payload, "covered"),
    render: ({ payload, context, timeZone, publicBaseUrl }) =>
      renderExomemCoveredInvitationEmail({
        acceptUrl: invitationUrl({ publicBaseUrl, payload }),
        inviterName: context.inviterName,
        note: context.note,
        inviteeEmail: context.email,
        expiresAt: new Date(payload.expiresAt),
        timeZone: context.timeZone ?? timeZone,
      }),
    afterSent: markStartLinkDelivered,
    afterFailed: revokeUndeliveredStartLink,
  }),
  /** Email 11: the one reminder before an unused friend invitation ends. */
  invitation_reminder: defineEmail({
    readPayload: readStartLinkPayload,
    stillHolds: (tx, payload) => namedInvitation(tx, payload, "friend"),
    render: ({ payload, context, timeZone, publicBaseUrl }) =>
      renderExomemInvitationReminderEmail({
        acceptUrl: invitationUrl({ publicBaseUrl, payload }),
        inviterName: context.inviterName,
        expiresAt: new Date(payload.expiresAt),
        leadDays: INVITATION_REMINDER_LEAD_DAYS,
        timeZone: context.timeZone ?? timeZone,
      }),
  }),
  /** Email 12, to the inviter: the friend invitation was used with the friend price. */
  invitation_used: defineEmail({
    readPayload: readInvitationNoticePayload,
    stillHolds: async (
      tx,
      payload
    ): Promise<{ inviteeName: string; usedAt: Date; timeZone: string | null } | null> => {
      const { rows } = await tx`
        /* exomem:email-invitation-used */
        SELECT invitee_name, consumed_at, inviter_email::text AS inviter_email
        FROM exomem_invites
        WHERE id = ${payload.inviteId}::uuid
          AND kind = 'friend'
          AND consumed_at IS NOT NULL
          AND inviter_email IS NOT NULL
          AND invitee_name IS NOT NULL
      `;
      const row = rows[0] as
        | { invitee_name: string; consumed_at: Date | string; inviter_email: string }
        | undefined;
      return row
        ? {
            inviteeName: row.invitee_name,
            usedAt: new Date(row.consumed_at),
            timeZone: await accountTimeZone(tx, row.inviter_email),
          }
        : null;
    },
    render: ({ context, timeZone }) =>
      renderExomemInvitationUsedEmail({
        inviteeName: context.inviteeName,
        usedAt: context.usedAt,
        // No price is stored when the invitation is used; the row is left out.
        friendPrice: null,
        timeZone: context.timeZone ?? timeZone,
      }),
  }),
  /** Email 13, to the inviter: the friend invitation ended unused. */
  invitation_ended: defineEmail({
    readPayload: readInvitationNoticePayload,
    stillHolds: async (
      tx,
      payload
    ): Promise<{ inviteeName: string; issuedAt: Date; expiredAt: Date } | null> => {
      const { rows } = await tx`
        /* exomem:email-invitation-ended */
        SELECT invitee_name, created_at, expires_at
        FROM exomem_invites
        WHERE id = ${payload.inviteId}::uuid
          AND kind = 'friend'
          AND consumed_at IS NULL
          AND revoked_at IS NULL
          AND expires_at <= now()
          AND inviter_email IS NOT NULL
          AND invitee_name IS NOT NULL
      `;
      const row = rows[0] as
        | { invitee_name: string; created_at: Date | string; expires_at: Date | string }
        | undefined;
      return row
        ? {
            inviteeName: row.invitee_name,
            issuedAt: new Date(row.created_at),
            expiredAt: new Date(row.expires_at),
          }
        : null;
    },
    render: ({ context }) =>
      renderExomemInvitationEndedEmail({
        inviteeName: context.inviteeName,
        issuedAt: context.issuedAt,
        expiredAt: context.expiredAt,
      }),
  }),
};
export type ExomemEmailKind = keyof typeof EXOMEM_EMAILS;
/** Every kind the outbox can send; `exomem_email_outbox_kind_check` must allow exactly these. */
export const EXOMEM_EMAIL_KINDS = Object.keys(EXOMEM_EMAILS) as ExomemEmailKind[];
const CLAIMED_LAST_KINDS = EXOMEM_EMAIL_KINDS.filter((kind) => EXOMEM_EMAILS[kind].claimedLast);

type PayloadOf<K extends ExomemEmailKind> = NonNullable<
  ReturnType<(typeof EXOMEM_EMAILS)[K]["readPayload"]>
>;

export type EnqueueExomemEmailInput<K extends ExomemEmailKind> = {
  kind: K;
  dedupeKey: string;
  recipient: string;
  recipientTimeZone: string | null;
  /** The account the email is about, so account deletion removes it whatever its address. */
  tenantId?: string;
  payload: PayloadOf<K>;
  notBefore?: Date;
  expiresAt?: Date;
};

/**
 * The encrypted payload column for one email, as JSON. For an enqueue that
 * one SQL statement makes together with its fact (the Paddle projection).
 */
export function sealExomemEmailPayload<K extends ExomemEmailKind>(
  _kind: K,
  payload: PayloadOf<K>
): string {
  return JSON.stringify(encryptSecret(JSON.stringify(payload)));
}

/**
 * Writes one email inside the caller's transaction. Returns `false` when an
 * email with this dedupe key already exists, so a repeat changes nothing.
 */
export async function enqueueExomemEmail<K extends ExomemEmailKind>(
  tx: ExomemSql,
  input: EnqueueExomemEmailInput<K>
): Promise<boolean> {
  const envelope = sealExomemEmailPayload(input.kind, input.payload);
  const { rows } = await tx`
    /* exomem:enqueue-email */
    INSERT INTO exomem_email_outbox (
      kind, dedupe_key, recipient, recipient_time_zone, tenant_id, payload_ciphertext,
      not_before, expires_at
    ) VALUES (
      ${input.kind},
      ${input.dedupeKey},
      ${input.recipient},
      ${input.recipientTimeZone},
      ${input.tenantId ?? null}::uuid,
      ${envelope}::jsonb,
      COALESCE(${input.notBefore?.toISOString() ?? null}::timestamptz, now()),
      ${input.expiresAt?.toISOString() ?? null}::timestamptz
    )
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING id
  `;
  return rows.length === 1;
}

type AnyDefinition = EmailDefinition<unknown, unknown>;

type LeasedEmail = {
  id: string;
  recipient: string;
  timeZone: string | null;
  definition: AnyDefinition;
  payload: unknown;
  context: unknown;
};

type ClaimResult =
  | { outcome: "leased"; email: LeasedEmail }
  | { outcome: "cancelled" | "failed" | "deferred" };

export type ExomemEmailDrainDependencies = {
  now: () => Date;
  newLeaseOwner: () => string;
  publicBaseUrl: string;
  decrypt: (envelope: SecretEnvelope) => string;
  sendEmail: typeof sendTransactionalEmail;
};

function defaults(): ExomemEmailDrainDependencies {
  return {
    now: () => new Date(),
    newLeaseOwner: randomUUID,
    publicBaseUrl: exomemPublicBaseUrlFromEnv(),
    decrypt: (envelope) => decryptSecret(envelope).reveal(),
    sendEmail: sendTransactionalEmail,
  };
}

async function settleWithoutSending(
  tx: ExomemSql,
  id: string,
  state: "cancelled" | "failed",
  errorCode: string
): Promise<void> {
  await tx`
    /* exomem:settle-email-unsent */
    UPDATE exomem_email_outbox
    SET state = ${state},
        payload_ciphertext = NULL,
        lease_owner = NULL,
        lease_expires_at = NULL,
        last_error_code = ${errorCode},
        updated_at = now()
    WHERE id = ${id}::uuid
  `;
}

async function claimNextEmail(
  leaseOwner: string,
  decrypt: ExomemEmailDrainDependencies["decrypt"]
): Promise<ClaimResult | null> {
  return withExomemTransaction(async (tx) => {
    const { rows } = await tx`
      /* exomem:claim-email */
      SELECT id, kind, recipient::text AS recipient, recipient_time_zone, payload_ciphertext,
             (expires_at IS NOT NULL AND expires_at <= now()) AS expired
      FROM exomem_email_outbox
      WHERE (state = 'pending' AND not_before <= now())
         OR (state = 'leased' AND lease_expires_at <= now())
      ORDER BY kind = ANY(${CLAIMED_LAST_KINDS}::text[]), not_before, created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    `;
    const row = rows[0] as
      | {
          id: string;
          kind: string;
          recipient: string;
          recipient_time_zone: string | null;
          payload_ciphertext: SecretEnvelope | string;
          expired: boolean;
        }
      | undefined;
    if (!row) return null;

    const definition = (EXOMEM_EMAILS as unknown as Record<string, AnyDefinition | undefined>)[
      row.kind
    ];
    if (!definition) {
      await settleWithoutSending(tx, row.id, "failed", "EMAIL_KIND_UNREGISTERED");
      return { outcome: "failed" };
    }
    let payload: unknown = null;
    try {
      const envelope =
        typeof row.payload_ciphertext === "string"
          ? (JSON.parse(row.payload_ciphertext) as SecretEnvelope)
          : row.payload_ciphertext;
      const value = JSON.parse(decrypt(envelope)) as unknown;
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        payload = definition.readPayload(value as Record<string, unknown>);
      }
    } catch {
      payload = null;
    }
    if (payload === null) {
      await settleWithoutSending(tx, row.id, "failed", "EMAIL_PAYLOAD_INVALID");
      return { outcome: "failed" };
    }

    const context = await definition.stillHolds(tx, payload);
    if (context === null) {
      await settleWithoutSending(tx, row.id, "cancelled", "EMAIL_PRECONDITION_GONE");
      return { outcome: "cancelled" };
    }
    if (row.expired) {
      await settleWithoutSending(tx, row.id, "failed", "EMAIL_EXPIRED");
      await definition.afterFailed?.(tx, payload, "EMAIL_EXPIRED");
      return { outcome: "failed" };
    }
    if (context instanceof NotYet) {
      await tx`
        /* exomem:defer-email */
        UPDATE exomem_email_outbox
        SET state = 'pending',
            not_before = ${context.until.toISOString()}::timestamptz,
            lease_owner = NULL,
            lease_expires_at = NULL,
            updated_at = now()
        WHERE id = ${row.id}::uuid
      `;
      return { outcome: "deferred" };
    }

    const to = definition.addressee?.(context) ?? {
      email: row.recipient,
      timeZone: row.recipient_time_zone,
    };
    // The row records where this attempt went, so support and account
    // deletion find it under the address that received it.
    await tx`
      /* exomem:lease-email */
      UPDATE exomem_email_outbox
      SET state = 'leased',
          attempts = attempts + 1,
          recipient = ${to.email},
          recipient_time_zone = ${to.timeZone},
          lease_owner = ${leaseOwner}::uuid,
          lease_expires_at = now() + (${LEASE_SECONDS} * interval '1 second'),
          updated_at = now()
      WHERE id = ${row.id}::uuid
    `;
    return {
      outcome: "leased",
      email: {
        id: row.id,
        recipient: to.email,
        timeZone: to.timeZone,
        definition,
        payload,
        context,
      },
    };
  });
}

async function markEmailSent(email: LeasedEmail, leaseOwner: string): Promise<boolean> {
  return withExomemTransaction(async (tx) => {
    const { rows } = await tx`
      /* exomem:mark-email-sent */
      UPDATE exomem_email_outbox
      SET state = 'sent',
          payload_ciphertext = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = NULL,
          sent_at = now(),
          updated_at = now()
      WHERE id = ${email.id}::uuid AND state = 'leased' AND lease_owner = ${leaseOwner}::uuid
      RETURNING id
    `;
    if (rows.length !== 1) return false;
    await email.definition.afterSent?.(tx, email.payload);
    return true;
  });
}

async function releaseEmail(
  email: LeasedEmail,
  leaseOwner: string,
  errorCode: string,
  terminal: boolean
): Promise<"retry" | "failed" | "lost"> {
  return withExomemTransaction(async (tx) => {
    const { rows } = await tx`
      /* exomem:lock-leased-email */
      SELECT attempts,
             expires_at IS NULL AS no_deadline,
             (expires_at IS NOT NULL
               AND expires_at <= now() + LEAST(power(2, attempts - 1), ${MAX_BACKOFF_MINUTES})
                                         * interval '1 minute') AS expires_before_retry
      FROM exomem_email_outbox
      WHERE id = ${email.id}::uuid AND state = 'leased' AND lease_owner = ${leaseOwner}::uuid
      FOR UPDATE
    `;
    const row = rows[0] as
      | { attempts: number; no_deadline: boolean; expires_before_retry: boolean }
      | undefined;
    if (!row) return "lost";
    const outOfAttempts = row.no_deadline && Number(row.attempts) >= MAX_ATTEMPTS_WITHOUT_DEADLINE;
    if (terminal || row.expires_before_retry || outOfAttempts) {
      await settleWithoutSending(tx, email.id, "failed", errorCode);
      await email.definition.afterFailed?.(tx, email.payload, errorCode);
      return "failed";
    }
    await tx`
      /* exomem:retry-email */
      UPDATE exomem_email_outbox
      SET state = 'pending',
          not_before = now() + LEAST(power(2, attempts - 1), ${MAX_BACKOFF_MINUTES}) * interval '1 minute',
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error_code = ${errorCode},
          updated_at = now()
      WHERE id = ${email.id}::uuid
    `;
    return "retry";
  });
}

/**
 * Deletes, for account deletion, every outbox row about the account and every
 * row addressed to its owner's current email. The account's rows go whatever
 * address they went to; pending rows go too: nothing is sent for an account
 * that is gone.
 */
export async function scrubExomemEmailsFor(
  tx: ExomemSql,
  account: { tenantId: string; email: string | null }
): Promise<number> {
  const { rows } = await tx`
    /* exomem:scrub-emails-for-account */
    DELETE FROM exomem_email_outbox
    WHERE tenant_id = ${account.tenantId}::uuid
       OR recipient = ${account.email}::citext
    RETURNING id
  `;
  return rows.length;
}

/**
 * Clears the recipient and their time zone from rows settled more than 30
 * days ago, in bounded batches. Their payload is already gone; the row and
 * its dedupe key stay, so the same fact still cannot send twice.
 */
export async function clearSettledEmailRecipients(limit = 500): Promise<number> {
  const { rows } = await executeExomemSql`
    /* exomem:clear-settled-email-recipients */
    WITH settled AS (
      SELECT id FROM exomem_email_outbox
      WHERE recipient IS NOT NULL
        AND state IN ('sent', 'failed', 'cancelled')
        AND updated_at < now() - (${SETTLED_RECIPIENT_RETENTION_DAYS} * interval '1 day')
      ORDER BY updated_at
      LIMIT ${Math.max(1, Math.min(Math.floor(limit), 5_000))}
    )
    UPDATE exomem_email_outbox AS outbox
    SET recipient = NULL, recipient_time_zone = NULL, payload_ciphertext = NULL
    FROM settled
    WHERE outbox.id = settled.id
    RETURNING outbox.id
  `;
  return rows.length;
}

/**
 * Whether the provider refused the request itself: the request-content
 * statuses of RFC 9110 (400, 413, 422). Such a refusal fails a
 * `failsWhenRefused` email at once, so a flood of refused waitlist emails
 * does not retry for a day; every other answer, and every other kind, is
 * retried until the row's deadline. A refusal can also be our own account's
 * fault, such as an unvalidated sender: then a waiting person gets no
 * waitlist email but keeps their place, and no start link or invitation is
 * revoked.
 */
function providerRefusedRequest(status: number | undefined): boolean {
  return status === 400 || status === 413 || status === 422;
}

export type ExomemEmailDrainResult = {
  recipientsCleared: number;
  /** Emails 03 queued this tick; `null` when that pass failed. */
  readyEnqueued: number | null;
  claimed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  cancelled: number;
  /** Claimed, but the fact will hold only later: put back until then. */
  deferred: number;
  lost: number;
};

/** One bounded pass over ready emails, at most 20 per tick. */
export async function drainExomemEmailOutbox(
  options: { maxMessages?: number; timeBudgetMs?: number } = {},
  dependencies?: Partial<ExomemEmailDrainDependencies>
): Promise<ExomemEmailDrainResult> {
  const deps = { ...defaults(), ...dependencies };
  const maxMessages = Math.max(
    1,
    Math.min(options.maxMessages ?? MAX_EMAILS_PER_TICK, MAX_EMAILS_PER_TICK)
  );
  const timeBudgetMs = Math.max(250, options.timeBudgetMs ?? 8_000);
  const started = Date.now();
  const leaseOwner = deps.newLeaseOwner();
  const publicBaseUrl = parseExomemPublicBaseUrl(deps.publicBaseUrl);
  const result: ExomemEmailDrainResult = {
    recipientsCleared: await clearSettledEmailRecipients(),
    // Before the drain, so a cell that became ready since the last tick is
    // announced in this one. Its failure must not hold back queued mail.
    readyEnqueued: await enqueueReadyEmails().then(
      (ready) => ready.enqueued,
      () => {
        console.error("exomem: ready email pass failed");
        return null;
      }
    ),
    claimed: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    cancelled: 0,
    deferred: 0,
    lost: 0,
  };

  while (result.claimed < maxMessages && Date.now() - started < timeBudgetMs) {
    const claim = await claimNextEmail(leaseOwner, deps.decrypt);
    if (!claim) break;
    result.claimed += 1;
    if (claim.outcome !== "leased") {
      result[claim.outcome] += 1;
      continue;
    }
    const email = claim.email;
    let rendered: RenderedExomemAccessEmail;
    try {
      rendered = await email.definition.render({
        payload: email.payload,
        context: email.context,
        timeZone: email.timeZone,
        now: deps.now(),
        publicBaseUrl,
      });
    } catch {
      const state = await releaseEmail(email, leaseOwner, "EMAIL_RENDER_FAILED", true);
      result[state === "retry" ? "retryScheduled" : state] += 1;
      continue;
    }
    let answer: SendTransactionalEmailResult | null = null;
    try {
      answer = await deps.sendEmail({
        to: email.recipient,
        ...EXOMEM_SENDER,
        // "Exomem", or "<name> via Exomem" when a person sent it; the address stays.
        senderName: rendered.senderName,
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        textContent: rendered.textContent,
      });
    } catch {
      answer = null;
    }
    if (answer?.success) {
      if (await markEmailSent(email, leaseOwner)) result.sent += 1;
      else result.lost += 1;
      continue;
    }
    const refused = providerRefusedRequest(answer?.status);
    const finalRefusal =
      refused && email.definition.failsWhenRefused === true && !email.definition.afterFailed;
    const state = await releaseEmail(
      email,
      leaseOwner,
      refused ? "EMAIL_REFUSED" : "EMAIL_DELIVERY_UNAVAILABLE",
      finalRefusal
    );
    result[state === "retry" ? "retryScheduled" : state] += 1;
  }
  return result;
}
