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
import { sendTransactionalEmail } from "@/lib/brevo";
import {
  renderExomemHoldReminderEmail,
  renderExomemPlaceOpenedEmail,
  renderExomemWaitlistEmail,
  renderExomemWelcomeEmail,
  type RenderedExomemAccessEmail,
} from "@/lib/email-templates/exomem-access";
import { EXOMEM_SENDER } from "@/lib/exomem-hosted/mail-sender";
import { executeExomemSql, withExomemTransaction, type ExomemSql } from "./db";
import { FIRST_PAYMENT_SOURCE_STATES } from "./entitlements";
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

type EmailRenderInput<P, C> = {
  payload: P;
  context: C;
  timeZone: string | null;
  now: Date;
  publicBaseUrl: string;
};

type EmailDefinition<P, C> = {
  /** Checks the decrypted payload's shape. `null` fails the row. */
  readPayload: (value: Record<string, unknown>) => P | null;
  /**
   * Re-checks, inside the claim's transaction, that the fact this email
   * announces still holds. `null` cancels the row. The value is passed to
   * `render`.
   */
  stillHolds: (tx: ExomemSql, payload: P) => Promise<C | null>;
  render: (input: EmailRenderInput<P, C>) => RenderedExomemAccessEmail;
  afterSent?: (tx: ExomemSql, payload: P) => Promise<void>;
  afterFailed?: (tx: ExomemSql, payload: P) => Promise<void>;
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
async function revokeUndeliveredStartLink(tx: ExomemSql, payload: StartLinkPayload): Promise<void> {
  await tx`
    /* exomem:email-start-link-undelivered */
    UPDATE exomem_invites
    SET delivery_state = 'failed',
        delivery_error_code = 'EMAIL_DELIVERY_UNAVAILABLE',
        revoked_at = COALESCE(revoked_at, now())
    WHERE id = ${payload.inviteId}::uuid AND consumed_at IS NULL
  `;
}

function startLinkUrl(input: EmailRenderInput<StartLinkPayload, true>): string {
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
  }),
  /**
   * Email 18: two days before an unpaid hold ends. It holds only while the
   * cell is still stopped and the tenant has not paid for the first time.
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
    stillHolds: async (tx, payload): Promise<{ timeZone: string | null } | null> => {
      const { rows } = await tx`
        /* exomem:email-hold-reminder-still-unpaid */
        SELECT tenant.time_zone
        FROM exomem_cloud_cells AS cell
        JOIN exomem_tenants AS tenant ON tenant.id = cell.tenant_id
        JOIN exomem_entitlements AS entitlement ON entitlement.tenant_id = cell.tenant_id
        WHERE cell.cell_id = ${payload.cellId}
          AND cell.desired_state = 'stopped'
          AND entitlement.source = 'paddle'
          AND entitlement.source_state = ANY(${[...FIRST_PAYMENT_SOURCE_STATES]}::text[])
      `;
      const row = rows[0] as { time_zone: string | null } | undefined;
      return row ? { timeZone: row.time_zone } : null;
    },
    render: ({ payload, context, timeZone, publicBaseUrl }) =>
      renderExomemHoldReminderEmail({
        setupUrl: new URL("/exomem/setup", `${publicBaseUrl}/`).toString(),
        holdEndsAt: new Date(payload.holdEndsAt),
        inviterName: payload.inviterName,
        // The zone the owner's browser last reported wins over the one the
        // invitation was sent with.
        timeZone: context.timeZone ?? timeZone,
      }),
  }),
};

export type ExomemEmailKind = keyof typeof EXOMEM_EMAILS;

type PayloadOf<K extends ExomemEmailKind> = NonNullable<
  ReturnType<(typeof EXOMEM_EMAILS)[K]["readPayload"]>
>;

export type EnqueueExomemEmailInput<K extends ExomemEmailKind> = {
  kind: K;
  dedupeKey: string;
  recipient: string;
  recipientTimeZone: string | null;
  payload: PayloadOf<K>;
  notBefore?: Date;
  expiresAt?: Date;
};

/**
 * Writes one email inside the caller's transaction. Returns `false` when an
 * email with this dedupe key already exists, so a repeat changes nothing.
 */
export async function enqueueExomemEmail<K extends ExomemEmailKind>(
  tx: ExomemSql,
  input: EnqueueExomemEmailInput<K>
): Promise<boolean> {
  const envelope = encryptSecret(JSON.stringify(input.payload));
  const { rows } = await tx`
    /* exomem:enqueue-email */
    INSERT INTO exomem_email_outbox (
      kind, dedupe_key, recipient, recipient_time_zone, payload_ciphertext, not_before, expires_at
    ) VALUES (
      ${input.kind},
      ${input.dedupeKey},
      ${input.recipient},
      ${input.recipientTimeZone},
      ${JSON.stringify(envelope)}::jsonb,
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

type ClaimResult = { outcome: "leased"; email: LeasedEmail } | { outcome: "cancelled" | "failed" };

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
      ORDER BY not_before, created_at
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
      await definition.afterFailed?.(tx, payload);
      return { outcome: "failed" };
    }

    await tx`
      /* exomem:lease-email */
      UPDATE exomem_email_outbox
      SET state = 'leased',
          attempts = attempts + 1,
          lease_owner = ${leaseOwner}::uuid,
          lease_expires_at = now() + (${LEASE_SECONDS} * interval '1 second'),
          updated_at = now()
      WHERE id = ${row.id}::uuid
    `;
    return {
      outcome: "leased",
      email: {
        id: row.id,
        recipient: row.recipient,
        timeZone: row.recipient_time_zone,
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
      await email.definition.afterFailed?.(tx, email.payload);
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
 * Deletes every outbox row addressed to one email, for account deletion.
 * Pending rows go too: nothing is sent to an address whose account is gone.
 */
export async function scrubExomemEmailsFor(tx: ExomemSql, email: string): Promise<number> {
  const { rows } = await tx`
    /* exomem:scrub-emails-for-address */
    DELETE FROM exomem_email_outbox WHERE recipient = ${email}::citext RETURNING id
  `;
  return rows.length;
}

/**
 * Clears the recipient of rows settled more than 30 days ago, in bounded
 * batches. Their payload is already gone; the row and its dedupe key stay,
 * so the same fact still cannot send twice.
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
    SET recipient = NULL, payload_ciphertext = NULL
    FROM settled
    WHERE outbox.id = settled.id
    RETURNING outbox.id
  `;
  return rows.length;
}

export type ExomemEmailDrainResult = {
  recipientsCleared: number;
  claimed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  cancelled: number;
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
    claimed: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    cancelled: 0,
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
      rendered = email.definition.render({
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
    let delivered = false;
    try {
      delivered = (
        await deps.sendEmail({
          to: email.recipient,
          ...EXOMEM_SENDER,
          subject: rendered.subject,
          htmlContent: rendered.htmlContent,
          textContent: rendered.textContent,
        })
      ).success;
    } catch {
      delivered = false;
    }
    if (delivered) {
      if (await markEmailSent(email, leaseOwner)) result.sent += 1;
      else result.lost += 1;
      continue;
    }
    const state = await releaseEmail(email, leaseOwner, "EMAIL_DELIVERY_UNAVAILABLE", false);
    result[state === "retry" ? "retryScheduled" : state] += 1;
  }
  return result;
}
