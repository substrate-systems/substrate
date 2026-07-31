import { createHash, timingSafeEqual } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { executeExomemSql } from "./db";
import { ExomemHostedError } from "./errors";

/** The K3s scheduler alert sender is a fixed contract we do not control.
 *
 * `scheduler_runtime.deliver_transition` POSTs a compact sorted JSON body to an
 * exact HTTPS URL with `Content-Type`/`Accept: application/json` and an
 * `X-Exomem-Alert-Transition` header, refuses any redirect, requires a 2xx
 * inside ten seconds, and sends **no** `Authorization` header. Authentication
 * therefore has to travel in the URL, and every bound below is chosen so the
 * receiver stays inside that contract.
 */
export const ALERT_MAX_BODY_BYTES = 4096;
export const ALERT_TRANSITION_HEADER = "x-exomem-alert-transition";
const ALERT_TOKEN_DIGEST_VARIABLE = "EXOMEM_HOSTED_ALERT_TOKEN_SHA256";
const ALERT_RECIPIENT_VARIABLE = "EXOMEM_HOSTED_ALERT_RECIPIENT";
const DEFAULT_ALERT_RECIPIENT = "founder@substratesystems.io";
/** Longest URL segment we will hash. Bounds work before any comparison. */
const ALERT_TOKEN_MAX_LENGTH = 256;
const HEX_64 = /^[0-9a-f]{64}$/;
const CONTRACT_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const ALERT_BODY_KEYS = ["active", "alert", "job", "schema_version", "transition_id"] as const;

export type AlertTransition = {
  transitionId: string;
  job: string;
  alert: string;
  active: boolean;
};

/** Deliberately a 404: the endpoint is an unguessable URL capability, so a
 * wrong token must be indistinguishable from a path that does not exist. A 401
 * would confirm the route to anyone probing for it. */
function notFound(): ExomemHostedError {
  return new ExomemHostedError({
    code: "ALERT_ENDPOINT_NOT_FOUND",
    status: 404,
    message: "not found",
  });
}

function payloadInvalid(): ExomemHostedError {
  return new ExomemHostedError({
    code: "ALERT_PAYLOAD_INVALID",
    status: 400,
    message: "the alert transition could not be accepted",
  });
}

function constantTimeEqualHex(provided: string, expected: string): boolean {
  const candidate = Buffer.from(provided, "utf8");
  const reference = Buffer.from(expected, "utf8");
  return candidate.length === reference.length && timingSafeEqual(candidate, reference);
}

/** Authenticate the URL capability against a stored digest.
 *
 * Only the SHA-256 of the token lives in Vercel configuration. The plaintext
 * exists solely inside the SOPS-delivered `ALERT_WEBHOOK_URL` on the K3s side,
 * so reading the receiver's environment does not yield a forgeable URL.
 */
export function verifyAlertToken(token: string | undefined): void {
  const expected = process.env[ALERT_TOKEN_DIGEST_VARIABLE];
  if (!expected || !HEX_64.test(expected)) throw notFound();
  if (!token || token.length > ALERT_TOKEN_MAX_LENGTH) throw notFound();
  const actual = createHash("sha256").update(token, "utf8").digest("hex");
  if (!constantTimeEqualHex(actual, expected)) throw notFound();
}

/** Accept exactly the sender's shape and nothing else.
 *
 * The header must restate the body's `transition_id`; a mismatch means the
 * request was assembled by something other than the pinned sender.
 */
export function parseAlertTransition(payload: unknown, headerTransitionId: string | null) {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw payloadInvalid();
  }
  const body = payload as Record<string, unknown>;
  const keys = Object.keys(body).sort();
  if (keys.length !== ALERT_BODY_KEYS.length) throw payloadInvalid();
  if (!keys.every((key, index) => key === ALERT_BODY_KEYS[index])) throw payloadInvalid();

  if (body.schema_version !== 1) throw payloadInvalid();
  const transitionId = body.transition_id;
  const job = body.job;
  const alert = body.alert;
  const active = body.active;
  if (typeof transitionId !== "string" || !HEX_64.test(transitionId)) throw payloadInvalid();
  if (typeof job !== "string" || !CONTRACT_LABEL.test(job)) throw payloadInvalid();
  if (typeof alert !== "string" || !CONTRACT_LABEL.test(alert)) throw payloadInvalid();
  if (typeof active !== "boolean") throw payloadInvalid();
  if (!headerTransitionId || !constantTimeEqualHex(headerTransitionId, transitionId)) {
    throw payloadInvalid();
  }
  return { transitionId, job, alert, active } satisfies AlertTransition;
}

/** Commit the transition before the caller returns 2xx.
 *
 * `DO NOTHING` makes redelivery idempotent: a repeated `transition_id` reports
 * `accepted: false` and must not produce a second notification.
 */
export async function recordAlertTransition(
  transition: AlertTransition
): Promise<{ accepted: boolean }> {
  const { rows } = await executeExomemSql`
    /* exomem:record-alert-transition */
    INSERT INTO exomem_hosted_alert_transitions (transition_id, job, alert, active)
    VALUES (${transition.transitionId}, ${transition.job}, ${transition.alert}, ${transition.active})
    ON CONFLICT (transition_id) DO NOTHING
    RETURNING transition_id
  `;
  return { accepted: rows.length === 1 };
}

export async function markAlertNotified(transitionId: string): Promise<void> {
  await executeExomemSql`
    /* exomem:mark-alert-notified */
    UPDATE exomem_hosted_alert_transitions
    SET notification_state = 'delivered',
        notification_attempts = notification_attempts + 1,
        notified_at = now(),
        last_error_code = NULL
    WHERE transition_id = ${transitionId}
  `;
}

export async function markAlertNotificationFailed(
  transitionId: string,
  errorCode: string
): Promise<void> {
  const bounded = /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : "UNKNOWN";
  await executeExomemSql`
    /* exomem:mark-alert-notification-failed */
    UPDATE exomem_hosted_alert_transitions
    SET notification_state = 'failed',
        notification_attempts = notification_attempts + 1,
        last_error_code = ${bounded}
    WHERE transition_id = ${transitionId}
  `;
}

/** Oldest transitions whose notification has not landed.
 *
 * Alerts recur, so flushing a bounded slice on each accepted delivery is enough
 * to drain a backlog without owning a cron slot. The Hobby cron budget is
 * already spent, and the pinned K3s schedule contract must not grow a job.
 */
export async function listUndeliveredAlerts(limit = 5): Promise<AlertTransition[]> {
  const bounded = Math.max(1, Math.min(20, Math.trunc(limit)));
  const { rows } = await executeExomemSql`
    /* exomem:list-undelivered-alerts */
    SELECT transition_id, job, alert, active
    FROM exomem_hosted_alert_transitions
    WHERE notification_state <> 'delivered'
    ORDER BY received_at ASC
    LIMIT ${bounded}
  `;
  return rows.map((row) => ({
    transitionId: String(row.transition_id),
    job: String(row.job),
    alert: String(row.alert),
    active: Boolean(row.active),
  }));
}

export async function countUndeliveredAlerts(): Promise<number> {
  const { rows } = await executeExomemSql`
    /* exomem:count-undelivered-alerts */
    SELECT count(*)::int AS undelivered
    FROM exomem_hosted_alert_transitions
    WHERE notification_state <> 'delivered'
  `;
  const value = rows[0]?.undelivered;
  return typeof value === "number" ? value : 0;
}

function renderNotification(transition: AlertTransition) {
  const state = transition.active ? "FIRING" : "RESOLVED";
  const subject = `[Exomem Hosted] ${state}: ${transition.alert} (${transition.job})`;
  const lines = [
    `Alert: ${transition.alert}`,
    `Job: ${transition.job}`,
    `State: ${state}`,
    `Transition: ${transition.transitionId}`,
  ];
  const textContent = `${lines.join("\n")}\n`;
  const htmlContent = `<pre>${lines.join("\n")}</pre>`;
  return { subject, textContent, htmlContent };
}

/** Send the operator notification.
 *
 * Only contract labels and the opaque transition digest are included; the
 * scheduler never sends tenant content and this must not invent any.
 */
export async function notifyAlertTransition(
  transition: AlertTransition
): Promise<{ delivered: boolean; errorCode?: string }> {
  const { subject, textContent, htmlContent } = renderNotification(transition);
  const to = process.env[ALERT_RECIPIENT_VARIABLE] ?? DEFAULT_ALERT_RECIPIENT;
  try {
    const result = await sendTransactionalEmail({ to, subject, htmlContent, textContent });
    if (!result.success) return { delivered: false, errorCode: "EMAIL_DELIVERY_FAILED" };
    return { delivered: true };
  } catch {
    // The Brevo client throws with configuration detail in the message. The
    // receiver records a stable code and never the caught value.
    return { delivered: false, errorCode: "EMAIL_DELIVERY_UNAVAILABLE" };
  }
}

/** Notify and durably record the outcome. Never throws: the transition is
 * already committed and a delivery failure must not turn into a non-2xx. */
export async function deliverAlertNotification(
  transition: AlertTransition
): Promise<{ delivered: boolean; errorCode?: string }> {
  const outcome = await notifyAlertTransition(transition);
  try {
    if (outcome.delivered) await markAlertNotified(transition.transitionId);
    else await markAlertNotificationFailed(transition.transitionId, outcome.errorCode ?? "UNKNOWN");
  } catch {
    return { delivered: outcome.delivered, errorCode: "NOTIFICATION_STATE_WRITE_FAILED" };
  }
  return outcome;
}
