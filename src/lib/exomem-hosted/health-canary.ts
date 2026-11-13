/**
 * The sign-in canary: a start request for an address that has no account,
 * made every time the email health proof runs, to prove that a start reaches
 * the provider and the inbox with nobody watching. The address is
 * configuration (`EXOMEM_HEALTH_START_CANARY_EMAIL`), never a stored record.
 *
 * This module holds only what the proof, the waitlist and the delivery report
 * all need to agree on: which address is the canary, the two time bounds, and
 * how one canary email is judged. It imports nothing from the start flow, so
 * the start flow may import it.
 */

/** The bucket key of the canary's start requests, so it never shares a rate-limit bucket with a real client. */
export const CANARY_NETWORK_KEY = "health-canary";

/**
 * The outbox kinds a canary start queues: a waitlist place the first time, a
 * still-waiting note on each later request. The canary always takes the
 * waitlist branch (it never holds a Cloud place).
 */
export const CANARY_EMAIL_KINDS = ["waitlist", "waitlist_still_waiting"] as const;

/** The canary's address as the outbox stores it (trimmed, lower case), or `null` when none is configured. */
export function healthCanaryAddress(
  value: string | undefined = process.env.EXOMEM_HEALTH_START_CANARY_EMAIL
): string | null {
  const address = value?.trim().toLowerCase();
  return address ? address : null;
}

function boundedSeconds(name: string, fallback: number, errorCode: string): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(errorCode);
  return value;
}

/** How long after it was due the provider must have accepted a canary email. A minute by default. */
export function healthCanaryQueueSeconds(): number {
  return boundedSeconds("EXOMEM_HEALTH_CANARY_QUEUE_SECONDS", 60, "INVALID_HEALTH_CANARY_QUEUE");
}

/** How long after acceptance the provider must have reported a canary email delivered. Ten minutes by default. */
export function healthCanaryDeliverySeconds(): number {
  return boundedSeconds(
    "EXOMEM_HEALTH_CANARY_DELIVERY_SECONDS",
    600,
    "INVALID_HEALTH_CANARY_DELIVERY"
  );
}

/** One canary email as the outbox and the provider's events hold it. */
export type CanaryEmail = {
  id: string;
  kind: string;
  state: string;
  createdAt: Date;
  /** The first due time; the queue time counts from here. */
  dueAt: Date;
  sentAt: Date | null;
  providerMessageId: string | null;
  /** The earliest `delivered` event for the message id, or `null` when the provider has reported none. */
  deliveredAt: Date | null;
};

export type CanaryFailure = "not_accepted" | "accepted_late" | "not_delivered";

export type CanaryJudgement = {
  /**
   * `passed`: accepted and delivered within the bounds. `pending`: no bound has
   * been broken yet, and the rest is still to come. `failed`: a bound broke,
   * named by `failure`.
   */
  verdict: "passed" | "pending" | "failed";
  failure: CanaryFailure | null;
  /** Seconds from due to provider acceptance; `null` until the provider accepted. */
  queueSeconds: number | null;
  /** Seconds from acceptance to the provider's `delivered` event; `null` until one arrived. */
  deliverySeconds: number | null;
};

const seconds = (from: Date, to: Date): number =>
  Math.max(0, (to.getTime() - from.getTime()) / 1000);

/**
 * Judges one canary email against the two bounds. A bound that has not yet
 * elapsed is `pending`, never a pass: a delivery the provider has not reported
 * is unknown until the bound runs out, and then it is a failure, because a
 * webhook that stopped reporting is as bad as a message that never arrived.
 */
export function judgeCanaryEmail(
  email: CanaryEmail,
  bounds: { queueSeconds: number; deliverySeconds: number },
  now: Date
): CanaryJudgement {
  const queueSeconds = email.sentAt ? seconds(email.dueAt, email.sentAt) : null;
  const deliverySeconds =
    email.sentAt && email.deliveredAt ? seconds(email.sentAt, email.deliveredAt) : null;
  const result = (
    verdict: CanaryJudgement["verdict"],
    failure: CanaryFailure | null
  ): CanaryJudgement => ({ verdict, failure, queueSeconds, deliverySeconds });

  if (email.state === "failed" || email.state === "cancelled") {
    return result("failed", "not_accepted");
  }
  if (email.state !== "sent" || !email.sentAt) {
    return seconds(email.dueAt, now) > bounds.queueSeconds
      ? result("failed", "not_accepted")
      : result("pending", null);
  }
  if (queueSeconds! > bounds.queueSeconds) return result("failed", "accepted_late");
  if (deliverySeconds !== null) {
    return deliverySeconds > bounds.deliverySeconds
      ? result("failed", "not_delivered")
      : result("passed", null);
  }
  return seconds(email.sentAt, now) > bounds.deliverySeconds
    ? result("failed", "not_delivered")
    : result("pending", null);
}
