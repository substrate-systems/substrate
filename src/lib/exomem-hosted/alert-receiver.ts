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
const ALERT_TOKEN_DIGEST_PREVIOUS_VARIABLE = "EXOMEM_HOSTED_ALERT_TOKEN_SHA256_PREVIOUS";
const ALERT_RECIPIENT_VARIABLE = "EXOMEM_HOSTED_ALERT_RECIPIENT";
const DEFAULT_ALERT_RECIPIENT = "founder@substratesystems.io";
/** Longest URL segment we will hash. Bounds work before any comparison. */
const ALERT_TOKEN_MAX_LENGTH = 256;
/** Attempts before a transition is parked as `failed`. Without a ceiling one
 * permanently undeliverable row would be retried ahead of every newer alert
 * forever, because claims are selected oldest-first. */
export const ALERT_MAX_NOTIFICATION_ATTEMPTS = 5;
/** Lease length for one claim. Comfortably longer than the Brevo timeout so a
 * slow send does not release its own claim mid-flight. */
const ALERT_CLAIM_SECONDS = 60;
const HEX_64 = /^[0-9a-f]{64}$/;
const CONTRACT_LABEL = /^[A-Za-z0-9_.:-]{1,64}$/;
const ALERT_BODY_KEYS = ["active", "alert", "job", "schema_version", "transition_id"] as const;

export type AlertTransition = {
  transitionId: string;
  job: string;
  alert: string;
  active: boolean;
};

export type AlertNotificationOutcome = {
  transitionId: string;
  job: string;
  alert: string;
  delivered: boolean;
  /** True when the row was already terminal or held by another invocation. */
  skipped: boolean;
  errorCode?: string;
};

/** Deliberately a 404 rather than a 401.
 *
 * The unguessable capability is the security control; this only avoids handing
 * a prober a positive confirmation for free. It is defence in depth, not the
 * boundary — see the method handlers in the route, and note that the JSON error
 * envelope still differs from the framework's own not-found page.
 */
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
 * so reading the receiver's environment does not yield a forgeable URL. It does
 * travel in the request path, so it is present in the platform's own request
 * logs; that residual is recorded in the secrets runbook.
 *
 * One explicit previous digest is accepted so rotation has no gap: the new
 * digest is published first, the single-version K3s sender URL cuts over, and
 * only then is the previous digest retired. This mirrors the two-version
 * receiver overlap used for `EXOMEM_HOSTED_SCHEDULER_SECRET`; no larger key
 * ring and no implicit fallback are accepted.
 */
export function verifyAlertToken(token: string | undefined): void {
  const active = process.env[ALERT_TOKEN_DIGEST_VARIABLE];
  if (!active || !HEX_64.test(active)) throw notFound();
  if (!token || token.length > ALERT_TOKEN_MAX_LENGTH) throw notFound();
  const previous = process.env[ALERT_TOKEN_DIGEST_PREVIOUS_VARIABLE];
  const accepted = [active, previous].filter(
    (digest): digest is string => typeof digest === "string" && HEX_64.test(digest)
  );
  const actual = createHash("sha256").update(token, "utf8").digest("hex");
  if (!accepted.some((digest) => constantTimeEqualHex(actual, digest))) throw notFound();
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
 * `DO NOTHING` makes redelivery idempotent at the storage layer. Note this says
 * nothing about notification: an existing row may still be undelivered, so the
 * caller must run the notification pass either way.
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

function rowToTransition(row: Record<string, unknown>): AlertTransition {
  return {
    transitionId: String(row.transition_id),
    job: String(row.job),
    alert: String(row.alert),
    // Explicit identity: `Boolean("f")` is true, so a driver that ever returned
    // the Postgres text form would invert a resolution into a firing alert.
    active: row.active === true,
  };
}

/** Take an exclusive, expiring lease on one transition's notification.
 *
 * Atomic by construction: the row is only claimable while `pending` and
 * unleased, so two concurrent invocations cannot both proceed to send. The
 * attempt counter increments on claim rather than on completion, so a claim
 * whose process dies still consumes an attempt and cannot loop forever.
 */
export async function claimAlertNotification(
  transitionId: string
): Promise<{ transition: AlertTransition; attempts: number } | null> {
  const { rows } = await executeExomemSql`
    /* exomem:claim-alert-notification */
    UPDATE exomem_hosted_alert_transitions
    SET notification_attempts = notification_attempts + 1,
        claimed_until = now() + make_interval(secs => ${ALERT_CLAIM_SECONDS})
    WHERE transition_id = ${transitionId}
      AND notification_state = 'pending'
      AND (claimed_until IS NULL OR claimed_until < now())
    RETURNING transition_id, job, alert, active, notification_attempts
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    transition: rowToTransition(row),
    attempts: Number(row.notification_attempts ?? 0),
  };
}

export async function markAlertNotified(transitionId: string): Promise<void> {
  await executeExomemSql`
    /* exomem:mark-alert-notified */
    UPDATE exomem_hosted_alert_transitions
    SET notification_state = 'delivered',
        notified_at = now(),
        claimed_until = NULL,
        last_error_code = NULL
    WHERE transition_id = ${transitionId}
      AND notification_state = 'pending'
  `;
}

/** Release the claim after a failed send.
 *
 * Scoped to `notification_state = 'pending'` so this can never move a delivered
 * row backwards, which would violate the `notified_at` invariant. Parks the row
 * as `failed` once the ceiling is reached so it stops blocking newer alerts.
 */
export async function releaseAlertNotification(
  transitionId: string,
  errorCode: string,
  attempts: number
): Promise<void> {
  const bounded = /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : "UNKNOWN";
  const exhausted = attempts >= ALERT_MAX_NOTIFICATION_ATTEMPTS;
  await executeExomemSql`
    /* exomem:release-alert-notification */
    UPDATE exomem_hosted_alert_transitions
    SET notification_state = ${exhausted ? "failed" : "pending"},
        claimed_until = NULL,
        last_error_code = ${bounded}
    WHERE transition_id = ${transitionId}
      AND notification_state = 'pending'
  `;
}

/** Mark a transition delivered without sending, because it carries no news.
 *
 * The sender recomputes `transition_id` from a sequence plus the transition
 * body, and the sequence does not advance until every delivery in a pass has
 * succeeded. A retried pass whose transition list has shifted therefore emits
 * the *same* state change under a *different* id, which the primary key cannot
 * catch. Comparing against the last delivered state for this (job, alert) does:
 * a genuine flap alternates `active`, a redelivery repeats it.
 */
export async function isRedundantTransition(transition: AlertTransition): Promise<boolean> {
  const { rows } = await executeExomemSql`
    /* exomem:latest-delivered-alert */
    SELECT active
    FROM exomem_hosted_alert_transitions
    WHERE job = ${transition.job}
      AND alert = ${transition.alert}
      AND notification_state = 'delivered'
      AND transition_id <> ${transition.transitionId}
    ORDER BY received_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return false;
  return (row.active === true) === transition.active;
}

/** Oldest claimable transitions. Ordered oldest-first so alerts are notified in
 * the order they happened; the attempt ceiling is what stops a stuck row from
 * holding that ordering hostage. */
export async function listClaimableAlerts(limit: number): Promise<string[]> {
  const bounded = Math.max(1, Math.min(20, Math.trunc(limit)));
  const { rows } = await executeExomemSql`
    /* exomem:list-claimable-alerts */
    SELECT transition_id
    FROM exomem_hosted_alert_transitions
    WHERE notification_state = 'pending'
      AND (claimed_until IS NULL OR claimed_until < now())
    ORDER BY received_at ASC
    LIMIT ${bounded}
  `;
  return rows.map((row) => String(row.transition_id));
}

export type AlertBacklog = { pending: number; failed: number };

/** Backlog health. `failed` is the one that needs a human: those transitions
 * exhausted their attempts and will never be retried on their own. */
export async function countAlertBacklog(): Promise<AlertBacklog> {
  const { rows } = await executeExomemSql`
    /* exomem:count-alert-backlog */
    SELECT
      count(*) FILTER (WHERE notification_state = 'pending')::int AS pending,
      count(*) FILTER (WHERE notification_state = 'failed')::int AS failed
    FROM exomem_hosted_alert_transitions
  `;
  const row = rows[0] ?? {};
  return {
    pending: typeof row.pending === "number" ? row.pending : 0,
    failed: typeof row.failed === "number" ? row.failed : 0,
  };
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

/** Claim, notify, and record one transition. Never throws: this runs after the
 * response has been sent, so there is nobody left to report an error to, and a
 * thrown error would abandon the rest of the pass. */
export async function deliverClaimedAlert(transitionId: string): Promise<AlertNotificationOutcome> {
  const base = { transitionId, job: "", alert: "" };
  let claim: Awaited<ReturnType<typeof claimAlertNotification>>;
  try {
    claim = await claimAlertNotification(transitionId);
  } catch {
    return { ...base, delivered: false, skipped: true, errorCode: "CLAIM_UNAVAILABLE" };
  }
  if (!claim) return { ...base, delivered: false, skipped: true };

  const { transition, attempts } = claim;
  const identity = {
    transitionId: transition.transitionId,
    job: transition.job,
    alert: transition.alert,
  };

  try {
    if (await isRedundantTransition(transition)) {
      await markAlertNotified(transition.transitionId);
      return { ...identity, delivered: true, skipped: true };
    }
  } catch {
    // A failed redundancy check must not block the alert. Notifying twice is
    // strictly better than not notifying at all.
  }

  const outcome = await notifyAlertTransition(transition);
  try {
    if (outcome.delivered) await markAlertNotified(transition.transitionId);
    else
      await releaseAlertNotification(
        transition.transitionId,
        outcome.errorCode ?? "UNKNOWN",
        attempts
      );
  } catch {
    // The lease expires on its own, so a lost state write self-heals into a
    // retry rather than stranding the row.
    return {
      ...identity,
      delivered: outcome.delivered,
      skipped: false,
      errorCode: "NOTIFICATION_STATE_WRITE_FAILED",
    };
  }
  return {
    ...identity,
    delivered: outcome.delivered,
    skipped: false,
    ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
  };
}

export type AlertBacklogMaintenance = AlertBacklog & { notified: number; errored: boolean };

/** Self-contained backlog maintenance for a caller that owns other work.
 *
 * Absorbs its own failures so an alert-delivery problem cannot be mistaken for
 * a failure of whatever job is hosting this pass; the caller reports the counts
 * instead. Never throws.
 */
export async function runAlertBacklogMaintenance(limit = 20): Promise<AlertBacklogMaintenance> {
  try {
    const outcomes = await runAlertNotificationPass({ limit });
    const backlog = await countAlertBacklog();
    return {
      notified: outcomes.filter((outcome) => outcome.delivered && !outcome.skipped).length,
      pending: backlog.pending,
      failed: backlog.failed,
      errored: false,
    };
  } catch {
    return { notified: 0, pending: 0, failed: 0, errored: true };
  }
}

/** One bounded notification pass.
 *
 * Runs after the response so it cannot spend the sender's ten-second budget.
 * A failing row no longer aborts the pass: every claimable row gets its turn,
 * and the attempt ceiling retires anything permanently undeliverable.
 */
export async function runAlertNotificationPass(options: {
  first?: string;
  limit?: number;
}): Promise<AlertNotificationOutcome[]> {
  const outcomes: AlertNotificationOutcome[] = [];
  const handled = new Set<string>();
  if (options.first) {
    handled.add(options.first);
    outcomes.push(await deliverClaimedAlert(options.first));
  }
  let claimable: string[];
  try {
    claimable = await listClaimableAlerts(options.limit ?? 5);
  } catch {
    return outcomes;
  }
  for (const transitionId of claimable) {
    if (handled.has(transitionId)) continue;
    handled.add(transitionId);
    outcomes.push(await deliverClaimedAlert(transitionId));
  }
  return outcomes;
}
