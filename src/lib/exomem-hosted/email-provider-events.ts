/**
 * What the mail provider says happened to an email after it accepted it.
 *
 * Brevo posts one webhook per event (or a batch; its shape is undocumented, so
 * a single object and an array are both read). An outbox row only records that
 * the provider accepted a send; these events record delivery, deferral and
 * bounces, keyed by the provider's message id. Each stored row holds the id,
 * the event name and its time, and nothing else: no address, subject, reason
 * text or IP.
 */
import { executeExomemSql } from "./db";

/** Brevo's documented transactional event names. Opens, clicks and proxy opens are not stored. */
export const PROVIDER_EVENTS = [
  "request",
  "delivered",
  "deferred",
  "soft_bounce",
  "hard_bounce",
  "blocked",
  "spam",
  "invalid_email",
  "error",
  "unsubscribed",
] as const;
export type ProviderEvent = (typeof PROVIDER_EVENTS)[number];

const STORED_EVENTS: ReadonlySet<string> = new Set(PROVIDER_EVENTS);
const MAX_MESSAGE_ID_LENGTH = 512;
/** Events older than this are deleted by the access-delivery job. */
export const PROVIDER_EVENT_RETENTION_DAYS = 30;
// An event time outside this range is a malformed field, not a late event.
const EARLIEST_EVENT_MS = Date.UTC(2020, 0, 1);
const MAX_FUTURE_EVENT_MS = 24 * 60 * 60 * 1000;

export type StoredProviderEvent = {
  providerMessageId: string;
  event: ProviderEvent;
  occurredAt: Date;
};

/**
 * The provider names a message with angle brackets in its send response and
 * may or may not in a webhook, so both forms reduce to the bare id. `null`
 * when the value is not a usable id.
 */
export function normalizeProviderMessageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const bare =
    trimmed.startsWith("<") && trimmed.endsWith(">") ? trimmed.slice(1, -1).trim() : trimmed;
  if (bare.length === 0 || bare.length > MAX_MESSAGE_ID_LENGTH) return null;
  // A message id is printable ASCII with no whitespace or brackets: a format check, not a reading of meaning.
  return /^[\x21-\x7e]+$/.test(bare) && !/[<>]/.test(bare) ? bare : null;
}

function eventTime(record: Record<string, unknown>): Date | null {
  // `ts_epoch` is milliseconds UTC; `ts_event` and `ts` are seconds.
  const candidates: Array<[unknown, number]> = [
    [record.ts_epoch, 1],
    [record.ts_event, 1000],
    [record.ts, 1000],
  ];
  for (const [raw, unit] of candidates) {
    const number = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof number !== "number" || !Number.isFinite(number)) continue;
    const ms = number * unit;
    if (ms >= EARLIEST_EVENT_MS && ms <= Date.now() + MAX_FUTURE_EVENT_MS) return new Date(ms);
  }
  return null;
}

export type ParsedProviderEvents = {
  /** Events to store, one per (message, event, time). */
  events: StoredProviderEvent[];
  /** Objects that are not a stored event: opens, clicks, unknown names, or no usable id or time. */
  ignored: number;
};

/** Reads one webhook body: an event object or an array of them. `null` when it is neither. */
export function parseProviderEvents(body: unknown): ParsedProviderEvents | null {
  const records = Array.isArray(body) ? body : [body];
  if (records.some((record) => typeof record !== "object" || record === null)) return null;
  const events = new Map<string, StoredProviderEvent>();
  let ignored = 0;
  for (const record of records as Array<Record<string, unknown>>) {
    const name = typeof record.event === "string" ? record.event : "";
    const providerMessageId = normalizeProviderMessageId(record["message-id"]);
    const occurredAt = eventTime(record);
    if (!STORED_EVENTS.has(name) || !providerMessageId || !occurredAt) {
      ignored += 1;
      continue;
    }
    // A batch can repeat an event; one statement must not name a key twice.
    events.set(`${providerMessageId}\u0000${name}\u0000${occurredAt.getTime()}`, {
      providerMessageId,
      event: name as ProviderEvent,
      occurredAt,
    });
  }
  return { events: [...events.values()], ignored };
}

/** Stores the events in one statement. Returns how many were new; the rest were already stored. */
export async function storeProviderEvents(events: readonly StoredProviderEvent[]): Promise<number> {
  if (events.length === 0) return 0;
  const { rows } = await executeExomemSql`
    /* exomem:store-provider-events */
    INSERT INTO exomem_email_provider_events (provider_message_id, event, occurred_at)
    SELECT * FROM unnest(
      ${events.map((event) => event.providerMessageId)}::text[],
      ${events.map((event) => event.event)}::text[],
      ${events.map((event) => event.occurredAt.toISOString())}::timestamptz[]
    )
    ON CONFLICT (provider_message_id, event, occurred_at) DO NOTHING
    RETURNING 1
  `;
  return rows.length;
}

/** Deletes provider events received more than 30 days ago, in a bounded batch. */
export async function pruneProviderEvents(limit = 1_000): Promise<number> {
  const { rows } = await executeExomemSql`
    /* exomem:prune-provider-events */
    DELETE FROM exomem_email_provider_events
    WHERE (provider_message_id, event, occurred_at) IN (
      SELECT provider_message_id, event, occurred_at
      FROM exomem_email_provider_events
      WHERE received_at < now() - (${PROVIDER_EVENT_RETENTION_DAYS} * interval '1 day')
      ORDER BY received_at
      LIMIT ${Math.max(1, Math.min(Math.floor(limit), 5_000))}
    )
    RETURNING 1
  `;
  return rows.length;
}
