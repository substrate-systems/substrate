import { randomBytes, randomUUID } from "node:crypto";
import { normalizeAccessEmail, requestStart, type AccessDependencies } from "./access";
import { dispatchExomemEmail } from "./email-outbox";
import { healthEmailOverdueSeconds, runFunctionalHealthCheck } from "./functional-health";
import { readEmailDeliveryStall, readLatestCanaryEmail } from "./functional-health-store";
import {
  CANARY_NETWORK_KEY,
  healthCanaryAddress,
  healthCanaryDeliverySeconds,
  healthCanaryQueueSeconds,
  judgeCanaryEmail,
  type CanaryFailure,
} from "./health-canary";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import { REPEAT_REPLY_WINDOW_MS } from "./self-serve-admission";

type CanaryErrorCode =
  | "CANARY_NOT_CONFIGURED"
  | "CANARY_NOT_QUEUED"
  | "CANARY_NOT_ACCEPTED"
  | "CANARY_ACCEPTED_LATE"
  | "CANARY_NOT_DELIVERED"
  | "EMAIL_DELIVERY_UNAVAILABLE"
  | "INTERNAL_ERROR";

const JUDGED_FAILURE_CODE: Record<CanaryFailure, CanaryErrorCode> = {
  not_accepted: "CANARY_NOT_ACCEPTED",
  accepted_late: "CANARY_ACCEPTED_LATE",
  not_delivered: "CANARY_NOT_DELIVERED",
};

// The cron route's request has no later moment to run work in, and the proof reads
// the outbox row at once, so the canary does inline what a browser request defers.
const CANARY_START_DEPENDENCIES: Partial<AccessDependencies> = {
  // The canary never takes a Cloud place: in `open` mode a free slot would admit it.
  admissionMode: () => "waitlist",
  afterResponse: (work) => work(),
  dispatchQueuedEmails: async (emailIds, { requestId }) => {
    for (const emailId of emailIds) await dispatchExomemEmail(emailId, undefined, requestId);
  },
};

/** The configured canary address in the form the start request stores, or `null` when unset or unusable. */
function usableCanaryAddress(): string | null {
  const configured = healthCanaryAddress();
  if (!configured) return null;
  try {
    return normalizeAccessEmail(configured);
  } catch {
    return null;
  }
}

/**
 * The email proof proves that a start request reaches the inbox, with nobody
 * watching, and that real traffic is not stalled. Each run:
 *
 * 1. judges the canary's newest email that is old enough for its delivery bound
 *    to have run out: the provider accepted it within
 *    `EXOMEM_HEALTH_CANARY_QUEUE_SECONDS` of its due time, and reported it
 *    delivered within `EXOMEM_HEALTH_CANARY_DELIVERY_SECONDS` of accepting it.
 *    Judging only old emails gives the provider the scheduler cadence (30
 *    minutes) to report, and makes a scheduler retry of a failed run reach the
 *    same verdict, instead of judging the email its first attempt just sent;
 * 2. sends a new canary through the start request itself, and requires that
 *    the provider accepted it with a message id before this run ends;
 * 3. fails when real traffic stalled: a queued email ready but unsent past
 *    `EXOMEM_HEALTH_EMAIL_OVERDUE_SECONDS`, or one that failed in the last hour
 *    for a reason other than the provider refusing it.
 *
 * The first runs have no old enough email and pass on their own acceptance.
 * Each run records the measured times in one content-free event.
 */
export function runEmailHealthCheck(): Promise<boolean> {
  return runFunctionalHealthCheck("email", async () => {
    let failure: CanaryErrorCode | null = null;
    let kind: string | undefined;
    let queueSeconds: number | null = null;
    let deliverySeconds: number | null = null;
    try {
      // Read first: a bad bound is a configuration failure that stops the proof before it sends.
      const overdueSeconds = healthEmailOverdueSeconds();
      const bounds = {
        queueSeconds: healthCanaryQueueSeconds(),
        deliverySeconds: healthCanaryDeliverySeconds(),
      };
      const address = usableCanaryAddress();
      if (!address) {
        failure = "CANARY_NOT_CONFIGURED";
        return false;
      }
      const judged = await readLatestCanaryEmail(address, bounds.deliverySeconds);
      const judgement = judged ? judgeCanaryEmail(judged, bounds, new Date()) : null;
      deliverySeconds = judgement?.deliverySeconds ?? null;

      // The canary skips only the browser bot check, and only inside this scheduler-authenticated cron: no public route reaches it.
      await requestStart(
        {
          email: address,
          networkKey: CANARY_NETWORK_KEY,
          browserChallengeDigest: randomBytes(32),
          timeZone: null,
          emailScheme: null,
          requestId: randomUUID(),
        },
        CANARY_START_DEPENDENCIES
      );
      // The newest email is the one this request queued. A request that queued none either repeated
      // an email of the last 15 minutes (a second run in one window, by design) or sent nothing:
      // a limit, or an address that has an account. Only the second is a failure.
      const current = await readLatestCanaryEmail(address, 0);
      if (!current || Date.now() - current.createdAt.getTime() >= REPEAT_REPLY_WINDOW_MS) {
        failure = "CANARY_NOT_QUEUED";
      } else {
        kind = current.kind;
        queueSeconds = judgeCanaryEmail(current, bounds, new Date()).queueSeconds;
        if (current.state !== "sent" || !current.providerMessageId) {
          failure = "CANARY_NOT_ACCEPTED";
        }
      }
      if (!failure && judgement?.failure) failure = JUDGED_FAILURE_CODE[judgement.failure];
      const stall = await readEmailDeliveryStall(overdueSeconds);
      if (!failure && (stall.overdue || stall.failedRecently)) {
        failure = "EMAIL_DELIVERY_UNAVAILABLE";
      }
      return failure === null;
    } catch {
      failure = "INTERNAL_ERROR";
      return false;
    } finally {
      emitOperationalEvent(
        buildOperationalEvent({
          event: "access.start.canary_checked",
          outcome: failure ? "failed" : "succeeded",
          errorCode: failure ?? undefined,
          emailKind: kind,
          queueMs: queueSeconds === null ? undefined : Math.round(queueSeconds * 1000),
          deliveryMs: deliverySeconds === null ? undefined : Math.round(deliverySeconds * 1000),
        })
      );
    }
  });
}
