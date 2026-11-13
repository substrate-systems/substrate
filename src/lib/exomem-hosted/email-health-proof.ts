import { randomBytes, randomUUID } from "node:crypto";
import { normalizeAccessEmail, requestStart } from "./access";
import { createExomemWaitBudget } from "./db";
import { dispatchExomemEmail } from "./email-outbox";
import { healthEmailOverdueSeconds, runFunctionalHealthCheck } from "./functional-health";
import {
  readCanaryEmail,
  readEmailDeliveryStall,
  readLatestCanaryEmail,
} from "./functional-health-store";
import {
  CANARY_NETWORK_KEY,
  healthCanaryAddress,
  healthCanaryDeliverySeconds,
  healthCanaryQueueSeconds,
  judgeCanaryEmail,
  type CanaryFailure,
} from "./health-canary";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import { startSelfServeAtomic, type StartResult } from "./self-serve-admission";

type CanaryErrorCode =
  | "CANARY_NOT_CONFIGURED"
  | "CANARY_NOT_QUEUED"
  | "CANARY_ADDRESS_HAS_ACCOUNT"
  | "CANARY_ADDRESS_HAS_INVITATION"
  | "CANARY_START_FAILED"
  | "CANARY_TIMED_OUT"
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

// The scheduler allows a run 20 s in all. The proof stops its own work at 10 s. A transaction in
// flight then ends on its own limits (a lock wait at 2 s, a statement at 3 s), and the proof waits
// for that at most 4 s, so it saves its failed result by 14 s even when a transaction never ends.
const PROOF_DEADLINE_MS = 10_000;
const SETTLE_GRACE_MS = 4_000;
const CANARY_WAIT_LIMITS = { lockTimeoutMs: 2_000, statementTimeoutMs: 3_000 };

type CanaryRun = {
  failure: CanaryErrorCode | null;
  kind?: string;
  /** This run's canary, from due time to the provider's acceptance. */
  queueSeconds?: number | null;
  /** The judged earlier canary, from acceptance to its `delivered` event. */
  deliverySeconds?: number | null;
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
 * Makes one start request for the canary and reports what this request did.
 * `requestStart` answers "accepted" whatever happened, so the public reply
 * never tells which branch ran, and it is left so. The proof needs the
 * branch, so it reads the outcome of the self-serve step that the request runs
 * inline.
 */
async function startCanary(
  address: string,
  signal: AbortSignal,
  budget: { readonly timedOut: boolean }
): Promise<{ failure: CanaryErrorCode } | { failure: null; kind: string; emailId: string | null }> {
  let start: StartResult | undefined;
  let started: Awaited<ReturnType<typeof requestStart>>;
  try {
    // The canary skips only the browser bot check, and only inside this scheduler-authenticated cron: no public route reaches it.
    started = await requestStart(
      {
        email: address,
        networkKey: CANARY_NETWORK_KEY,
        browserChallengeDigest: randomBytes(32),
        timeZone: null,
        emailScheme: null,
        requestId: randomUUID(),
      },
      {
        // The cron route has no later moment to run work in, and the proof reads the outcome at once.
        afterResponse: (work) => work(),
        startSelfServe: async (input) => (start = await startSelfServeAtomic(input)),
        dispatchQueuedEmails: async (emailIds, { requestId }) => {
          // What the provider answered is read from the outbox row, which the proof needs for its times anyway.
          for (const emailId of emailIds) await dispatchExomemEmail(emailId, undefined, requestId);
        },
      }
    );
  } catch {
    // Its rate-limit step runs before the start and is not swallowed: a throw there is a failed start too.
    return {
      failure: signal.aborted || budget.timedOut ? "CANARY_TIMED_OUT" : "CANARY_START_FAILED",
    };
  }
  // A sign-in link was queued: the address owns an account, so the proof would mail a real person.
  if (started.deliveryId) return { failure: "CANARY_ADDRESS_HAS_ACCOUNT" };
  if (started.limitedBy) return { failure: "CANARY_NOT_QUEUED" };
  if (signal.aborted || budget.timedOut) return { failure: "CANARY_TIMED_OUT" };
  // `requestStart` has no other exit before the self-serve step: no link, no limit and no start
  // means that its owner lookup or the start itself threw, and that is a failed start.
  if (!start) return { failure: "CANARY_START_FAILED" };
  switch (start.outcome) {
    case "waitlisted":
    case "still_waiting": {
      const kind = start.outcome === "waitlisted" ? "waitlist" : "waitlist_still_waiting";
      // A null id is the repeat: this window's reply was queued before, and proveSignIn reads it.
      return { failure: null, kind, emailId: start.emailId };
    }
    case "invitation_waiting":
      return { failure: "CANARY_ADDRESS_HAS_INVITATION" };
    default:
      // `admitted` and `reissued` give a Cloud place: the start never gives one to the canary.
      return { failure: "CANARY_NOT_QUEUED" };
  }
}

async function proveSignIn(
  signal: AbortSignal,
  budget: { readonly timedOut: boolean }
): Promise<CanaryRun> {
  // Read first: a bad bound is a configuration failure that stops the proof before it sends.
  const overdueSeconds = healthEmailOverdueSeconds();
  const bounds = {
    queueSeconds: healthCanaryQueueSeconds(),
    deliverySeconds: healthCanaryDeliverySeconds(),
  };
  const address = usableCanaryAddress();
  if (!address) return { failure: "CANARY_NOT_CONFIGURED" };
  const judged = await readLatestCanaryEmail(address, bounds.deliverySeconds);
  const judgement = judged ? judgeCanaryEmail(judged, bounds, new Date()) : null;
  const run: CanaryRun = { failure: null, deliverySeconds: judgement?.deliverySeconds ?? null };

  const started = await startCanary(address, signal, budget);
  run.failure = started.failure;
  if (started.failure === null) {
    run.kind = started.kind;
    // A repeat names no row. This window has one canary reply, and it is the newest canary email.
    // It counts only once the provider has accepted it: a queued row proves nothing.
    const email = started.emailId
      ? await readCanaryEmail(started.emailId)
      : await readLatestCanaryEmail(address, 0);
    if (started.emailId && email) {
      run.queueSeconds = judgeCanaryEmail(email, bounds, new Date()).queueSeconds;
    }
    if (email?.state !== "sent" || !email.providerMessageId) run.failure = "CANARY_NOT_ACCEPTED";
  }
  if (!run.failure && judgement?.failure) run.failure = JUDGED_FAILURE_CODE[judgement.failure];
  if (!run.failure) {
    const stall = await readEmailDeliveryStall(overdueSeconds);
    if (stall.overdue || stall.failedRecently) run.failure = "EMAIL_DELIVERY_UNAVAILABLE";
  }
  return run;
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
 * 2. sends a new canary through the start request itself. This run's own
 *    start decides the result: the waitlist email that it queued, or that this
 *    15-minute window queued before, must be accepted by the provider with a
 *    message id. An address that owns an account or holds an invitation, a
 *    start that fails and a wait that hits its limit each fail with a code;
 * 3. fails when real traffic stalled: a queued email ready but unsent past
 *    `EXOMEM_HEALTH_EMAIL_OVERDUE_SECONDS`, or one that failed in the last hour
 *    for a reason other than the provider refusing it.
 *
 * Every database wait of the run has a limit, and the whole run stops at
 * `PROOF_DEADLINE_MS`. It waits for the transaction in flight to end, up to
 * `SETTLE_GRACE_MS`, then saves a failed proof inside the scheduler's timeout.
 * The first runs have no old enough email and pass on their own acceptance.
 * Each run records the measured times in one content-free event.
 */
export function runEmailHealthCheck(options: { deadlineMs?: number } = {}): Promise<boolean> {
  return runFunctionalHealthCheck("email", async () => {
    const deadline = new AbortController();
    const budget = createExomemWaitBudget({ ...CANARY_WAIT_LIMITS, signal: deadline.signal });
    const timer = setTimeout(() => deadline.abort(), options.deadlineMs ?? PROOF_DEADLINE_MS);
    let run: CanaryRun;
    try {
      // The abort opens no new transaction; the race returns the failure now, whatever step is waiting.
      run = await Promise.race([
        budget.run(() => proveSignIn(deadline.signal, budget)),
        new Promise<CanaryRun>((resolve) =>
          deadline.signal.addEventListener(
            "abort",
            () => resolve({ failure: "CANARY_TIMED_OUT" }),
            { once: true }
          )
        ),
      ]);
    } catch {
      run = { failure: budget.timedOut ? "CANARY_TIMED_OUT" : "INTERNAL_ERROR" };
    } finally {
      clearTimeout(timer);
    }
    // The proof settles after the transaction in flight has ended; the grace only keeps a transaction that never ends from holding the run.
    if (deadline.signal.aborted) {
      let grace: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        budget.idle(),
        new Promise<void>((resolve) => (grace = setTimeout(resolve, SETTLE_GRACE_MS))),
      ]);
      clearTimeout(grace);
    }
    emitOperationalEvent(
      buildOperationalEvent({
        event: "access.start.canary_checked",
        outcome: run.failure ? "failed" : "succeeded",
        errorCode: run.failure ?? undefined,
        emailKind: run.kind,
        queueMs: run.queueSeconds == null ? undefined : Math.round(run.queueSeconds * 1000),
        deliveryMs:
          run.deliverySeconds == null ? undefined : Math.round(run.deliverySeconds * 1000),
      })
    );
    return run.failure === null;
  });
}
