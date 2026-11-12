/**
 * The operator's view of Exomem email delivery: what was queued, whether it
 * was sent, failed or cancelled, how long each step took, and what the
 * provider reported afterwards. Two sources feed it: the two outboxes (our
 * side, down to provider acceptance) and the provider's webhook events (the
 * provider's side, delivery and bounces). It reads, never writes, and holds no
 * address, subject or reason text.
 */
import { executeExomemSql } from "./db";

export const EMAIL_DELIVERY_DEFAULT_HOURS = 24;
export const EMAIL_DELIVERY_MAX_HOURS = 168;

/** Parses the `hours` query value: absent means the default; anything else must be a whole number in range. */
export function parseEmailDeliveryHours(value: string | null): number | null {
  if (value === null) return EMAIL_DELIVERY_DEFAULT_HOURS;
  if (!/^\d{1,4}$/.test(value)) return null;
  const hours = Number(value);
  return hours >= 1 && hours <= EMAIL_DELIVERY_MAX_HOURS ? hours : null;
}

export type Latency = {
  /** Milliseconds, or `null` when no email in the window has this measurement. */
  p50Ms: number | null;
  p95Ms: number | null;
  /** How many emails the percentiles are over. */
  samples: number;
};

export type EmailKindDelivery = {
  kind: string;
  /** Created in the window. */
  queued: number;
  sent: number;
  failed: number;
  cancelled: number;
  /** Unsettled now, of any age: waiting for its first due time, retrying or in flight. */
  pending: number;
  /** The part of `pending` that was due and is still unsent. */
  pendingPastDue: number;
  /** Provider acceptance with no message id recorded, so no provider event can be matched to it. */
  acceptedWithoutProviderId: number;
  queueToAccepted: Latency;
  /** `null` until the provider has reported at least one event, ever. */
  delivery: null | {
    delivered: number;
    deferred: number;
    softBounce: number;
    hardBounce: number;
    blocked: number;
    spam: number;
    invalid: number;
    error: number;
    acceptedToDelivered: Latency;
  };
};

export type EmailDeliveryReport = {
  window: { hours: number; from: string; to: string };
  sources: { queue: string[]; providerEvents: string };
  /**
   * `none_received`: the webhook has never delivered an event, so delivery is unknown, not zero.
   * `received_partial_window`: events began after the window started, so earlier delivery is unknown.
   */
  deliveryEvidence: "none_received" | "received" | "received_partial_window";
  /** The earliest stored provider event's receipt time, or `null` when none. */
  providerEventsSince: string | null;
  kinds: EmailKindDelivery[];
};

type KindRow = {
  kind: string;
  queued: string | number;
  sent: string | number;
  failed: string | number;
  cancelled: string | number;
  pending: string | number;
  pending_past_due: string | number;
  accepted_without_id: string | number;
  queue_samples: string | number;
  queue_p50_ms: string | number | null;
  queue_p95_ms: string | number | null;
  delivered: string | number;
  deferred: string | number;
  soft_bounce: string | number;
  hard_bounce: string | number;
  blocked: string | number;
  spam: string | number;
  invalid: string | number;
  error: string | number;
  delivery_samples: string | number;
  delivery_p50_ms: string | number | null;
  delivery_p95_ms: string | number | null;
};

const count = (value: string | number): number => Number(value);
const millis = (value: string | number | null): number | null =>
  value === null ? null : Math.round(Number(value));

/**
 * One bounded read. The window selects by `created_at` through an index on each
 * outbox; the backlog counts read the partial index of unsettled rows; events
 * are matched by message id through the events table's unique index. Magic-link
 * emails are their own kind, from their own outbox. Queue time counts from the
 * row's first due time (`due_at`), so a reminder that is due days after it was
 * queued does not read as a slow send; rows from before that column exist have
 * no first due time and are left out of the latency.
 */
export async function readEmailDeliveryReport(
  hours: number,
  now: Date = new Date()
): Promise<EmailDeliveryReport> {
  const from = new Date(now.getTime() - hours * 3_600_000);
  const [kindResult, evidenceResult] = await Promise.all([
    executeExomemSql`
      /* exomem:email-delivery-report */
      WITH window_rows AS (
        SELECT id, kind, state, provider_message_id, sent_at,
               CASE WHEN state = 'sent' AND due_at IS NOT NULL
                    THEN GREATEST(0, extract(epoch FROM (sent_at - due_at)) * 1000) END AS queue_ms
        FROM exomem_email_outbox
        WHERE created_at >= ${from.toISOString()}::timestamptz
        UNION ALL
        SELECT id, 'magic_link', state, provider_message_id, sent_at,
               CASE WHEN state = 'sent'
                    THEN GREATEST(0, extract(epoch FROM (sent_at - created_at)) * 1000) END
        FROM exomem_access_delivery_outbox
        WHERE created_at >= ${from.toISOString()}::timestamptz
      ), backlog AS (
        SELECT kind, count(*) AS pending, count(*) FILTER (WHERE not_before <= now()) AS past_due
        FROM exomem_email_outbox
        WHERE state IN ('pending', 'leased')
        GROUP BY kind
        UNION ALL
        SELECT 'magic_link', count(*), count(*) FILTER (WHERE next_attempt_at <= now())
        FROM exomem_access_delivery_outbox
        WHERE state IN ('pending', 'leased')
        HAVING count(*) > 0
      ), per_message AS (
        SELECT w.id, w.kind, w.sent_at,
               min(e.occurred_at) FILTER (WHERE e.event = 'delivered') AS delivered_at,
               bool_or(e.event = 'deferred') AS deferred,
               bool_or(e.event = 'soft_bounce') AS soft_bounce,
               bool_or(e.event = 'hard_bounce') AS hard_bounce,
               bool_or(e.event = 'blocked') AS blocked,
               bool_or(e.event = 'spam') AS spam,
               bool_or(e.event = 'invalid_email') AS invalid,
               bool_or(e.event = 'error') AS error
        FROM window_rows AS w
        JOIN exomem_email_provider_events AS e ON e.provider_message_id = w.provider_message_id
        WHERE w.state = 'sent'
        GROUP BY w.id, w.kind, w.sent_at
      ), window_stats AS (
        SELECT kind,
               count(*) AS queued,
               count(*) FILTER (WHERE state = 'sent') AS sent,
               count(*) FILTER (WHERE state = 'failed') AS failed,
               count(*) FILTER (WHERE state = 'cancelled') AS cancelled,
               count(*) FILTER (WHERE state = 'sent' AND provider_message_id IS NULL) AS accepted_without_id,
               count(queue_ms) AS queue_samples,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY queue_ms) AS queue_p50_ms,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY queue_ms) AS queue_p95_ms
        FROM window_rows
        GROUP BY kind
      ), delivery_stats AS (
        SELECT kind,
               count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivered,
               count(*) FILTER (WHERE deferred) AS deferred,
               count(*) FILTER (WHERE soft_bounce) AS soft_bounce,
               count(*) FILTER (WHERE hard_bounce) AS hard_bounce,
               count(*) FILTER (WHERE blocked) AS blocked,
               count(*) FILTER (WHERE spam) AS spam,
               count(*) FILTER (WHERE invalid) AS invalid,
               count(*) FILTER (WHERE error) AS error,
               count(*) FILTER (WHERE delivered_at IS NOT NULL) AS delivery_samples,
               percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY GREATEST(0, extract(epoch FROM (delivered_at - sent_at)) * 1000)
               ) FILTER (WHERE delivered_at IS NOT NULL) AS delivery_p50_ms,
               percentile_cont(0.95) WITHIN GROUP (
                 ORDER BY GREATEST(0, extract(epoch FROM (delivered_at - sent_at)) * 1000)
               ) FILTER (WHERE delivered_at IS NOT NULL) AS delivery_p95_ms
        FROM per_message
        GROUP BY kind
      )
      SELECT kinds.kind,
             COALESCE(window_stats.queued, 0) AS queued,
             COALESCE(window_stats.sent, 0) AS sent,
             COALESCE(window_stats.failed, 0) AS failed,
             COALESCE(window_stats.cancelled, 0) AS cancelled,
             COALESCE(backlog.pending, 0) AS pending,
             COALESCE(backlog.past_due, 0) AS pending_past_due,
             COALESCE(window_stats.accepted_without_id, 0) AS accepted_without_id,
             COALESCE(window_stats.queue_samples, 0) AS queue_samples,
             window_stats.queue_p50_ms, window_stats.queue_p95_ms,
             COALESCE(delivery_stats.delivered, 0) AS delivered,
             COALESCE(delivery_stats.deferred, 0) AS deferred,
             COALESCE(delivery_stats.soft_bounce, 0) AS soft_bounce,
             COALESCE(delivery_stats.hard_bounce, 0) AS hard_bounce,
             COALESCE(delivery_stats.blocked, 0) AS blocked,
             COALESCE(delivery_stats.spam, 0) AS spam,
             COALESCE(delivery_stats.invalid, 0) AS invalid,
             COALESCE(delivery_stats.error, 0) AS error,
             COALESCE(delivery_stats.delivery_samples, 0) AS delivery_samples,
             delivery_stats.delivery_p50_ms, delivery_stats.delivery_p95_ms
      FROM (SELECT kind FROM window_stats UNION SELECT kind FROM backlog) AS kinds
      LEFT JOIN window_stats USING (kind)
      LEFT JOIN backlog USING (kind)
      LEFT JOIN delivery_stats USING (kind)
      ORDER BY kinds.kind
    `,
    executeExomemSql`
      /* exomem:email-provider-events-since */
      SELECT min(received_at) AS since FROM exomem_email_provider_events
    `,
  ]);

  const rawSince = evidenceResult.rows[0]?.since;
  const providerEventsSince = rawSince ? new Date(String(rawSince)) : null;
  const deliveryEvidence =
    providerEventsSince === null
      ? "none_received"
      : providerEventsSince > from
        ? "received_partial_window"
        : "received";

  const kinds = (kindResult.rows as KindRow[]).map((row): EmailKindDelivery => {
    const received = deliveryEvidence !== "none_received";
    return {
      kind: row.kind,
      queued: count(row.queued),
      sent: count(row.sent),
      failed: count(row.failed),
      cancelled: count(row.cancelled),
      pending: count(row.pending),
      pendingPastDue: count(row.pending_past_due),
      acceptedWithoutProviderId: count(row.accepted_without_id),
      queueToAccepted: {
        p50Ms: millis(row.queue_p50_ms),
        p95Ms: millis(row.queue_p95_ms),
        samples: count(row.queue_samples),
      },
      delivery: received
        ? {
            delivered: count(row.delivered),
            deferred: count(row.deferred),
            softBounce: count(row.soft_bounce),
            hardBounce: count(row.hard_bounce),
            blocked: count(row.blocked),
            spam: count(row.spam),
            invalid: count(row.invalid),
            error: count(row.error),
            acceptedToDelivered: {
              p50Ms: millis(row.delivery_p50_ms),
              p95Ms: millis(row.delivery_p95_ms),
              samples: count(row.delivery_samples),
            },
          }
        : null,
    };
  });

  return {
    window: { hours, from: from.toISOString(), to: now.toISOString() },
    sources: {
      queue: ["exomem_email_outbox", "exomem_access_delivery_outbox"],
      providerEvents: "exomem_email_provider_events (Brevo transactional webhook)",
    },
    deliveryEvidence,
    providerEventsSince: providerEventsSince?.toISOString() ?? null,
    kinds,
  };
}
