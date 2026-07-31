import { NextRequest, NextResponse, after } from "next/server";
import { safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { emitAccessEvent, newRequestId, readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import {
  ALERT_MAX_BODY_BYTES,
  ALERT_TRANSITION_HEADER,
  countAlertBacklog,
  parseAlertTransition,
  recordAlertTransition,
  runAlertNotificationPass,
  verifyAlertToken,
  type AlertTransition,
} from "@/lib/exomem-hosted/alert-receiver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/** The notification pass runs after the response, but still inside this
 * invocation's lifetime, so the ceiling has to cover it. */
export const maxDuration = 60;

/** Terminates the K3s scheduler alert sender.
 *
 * The sender refuses redirects and requires a 2xx within ten seconds, so this
 * route is exact (no trailing slash, no rewrite) and commits before it answers.
 * Notification runs in `after()` so a slow mail provider can never spend the
 * sender's budget and burn its two attempts. It lives on Vercel deliberately:
 * an alert about K3s being unreachable is worthless if it has to traverse K3s
 * to arrive.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
): Promise<NextResponse> {
  const requestId = newRequestId();
  let transition: AlertTransition;
  try {
    const { token } = await params;
    verifyAlertToken(token);
    const payload = await readBoundedJsonRequest(request, ALERT_MAX_BODY_BYTES);
    transition = parseAlertTransition(payload, request.headers.get(ALERT_TRANSITION_HEADER));
  } catch (error) {
    // Carries the code, so probing for the capability is distinguishable from
    // a malformed or oversized body in the log stream.
    emitAccessEvent({
      event: "alerts.transition.denied",
      outcome: "denied",
      requestId,
      errorCode: error instanceof Error && "code" in error ? String(error.code) : "INTERNAL_ERROR",
    });
    return safeErrorResponse(error, requestId);
  }

  let accepted: boolean;
  try {
    // Durability boundary: everything after this point may fail without
    // costing us the transition.
    ({ accepted } = await recordAlertTransition(transition));
  } catch {
    // Not yet durable, so the sender must retry. Its retry budget is one
    // attempt with a maximum of two, which is why this stays a 5xx rather than
    // a polite 2xx that would silently drop the alert. The sender only advances
    // its alert state after every delivery succeeds, so an unacknowledged
    // transition is re-derived on the next evaluation.
    emitAccessEvent({
      event: "alerts.transition.unavailable",
      outcome: "failed",
      requestId,
      errorCode: "ALERT_STORE_UNAVAILABLE",
      alertJob: transition.job,
      alertName: transition.alert,
      transitionHash: transition.transitionId,
    });
    return NextResponse.json(
      { success: false, error: { code: "ALERT_STORE_UNAVAILABLE", retryable: true } },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }

  emitAccessEvent({
    event: accepted ? "alerts.transition.accepted" : "alerts.transition.duplicate",
    outcome: "succeeded",
    requestId,
    alertJob: transition.job,
    alertName: transition.alert,
    transitionHash: transition.transitionId,
  });

  // Deliberately runs for a duplicate too. A redelivery whose first attempt
  // died after committing but before notifying would otherwise be acknowledged
  // forever with nothing ever sent. The claim makes the repeat safe.
  scheduleNotificationPass(requestId, transition.transitionId);

  return NextResponse.json(
    { success: true, accepted },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}

/** Hand the notification pass to the platform's post-response hook.
 *
 * `after` throws when there is no request scope. The transition is already
 * durable at this point, so that must never turn into a 500 that tells the
 * sender to retry something we actually accepted — the pass is dropped, logged,
 * and the row is picked up by the next transition's pass or the backlog cron.
 */
function scheduleNotificationPass(requestId: string, transitionId: string): void {
  try {
    after(async () => {
      const outcomes = await runAlertNotificationPass({ first: transitionId, limit: 5 });
      for (const outcome of outcomes) {
        if (outcome.skipped && !outcome.delivered) continue;
        emitAccessEvent({
          event: outcome.delivered ? "alerts.notification.delivered" : "alerts.notification.failed",
          outcome: outcome.delivered ? "succeeded" : "failed",
          requestId,
          alertJob: outcome.job,
          alertName: outcome.alert,
          transitionHash: outcome.transitionId,
          ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
        });
      }
      await emitBacklogSignal(requestId);
    });
  } catch {
    emitAccessEvent({
      event: "alerts.notification.failed",
      outcome: "failed",
      requestId,
      transitionHash: transitionId,
      errorCode: "NOTIFICATION_NOT_SCHEDULED",
    });
  }
}

/** Surface the undelivered backlog on every delivery.
 *
 * An alerting system whose own delivery fails silently is worse than none, so
 * a non-empty backlog is itself an event. `failed` means the attempt ceiling
 * was reached and nothing will retry those without a human.
 */
export async function emitBacklogSignal(requestId: string): Promise<void> {
  try {
    const backlog = await countAlertBacklog();
    if (backlog.pending === 0 && backlog.failed === 0) return;
    emitAccessEvent({
      event: "alerts.backlog.undelivered",
      outcome: backlog.failed > 0 ? "failed" : "pending",
      requestId,
      countBucket: `pending-${bucket(backlog.pending)}-failed-${bucket(backlog.failed)}`,
    });
  } catch {
    // Never let the health signal break the pass that produced it.
  }
}

function bucket(value: number): string {
  if (value === 0) return "0";
  if (value === 1) return "1";
  if (value <= 5) return "2-5";
  if (value <= 20) return "6-20";
  return "20plus";
}

/** The route matches any single segment, so without these the framework would
 * answer 405 with an `Allow` header for a wrong method and confirm the endpoint
 * exists to an unauthenticated prober. */
function methodNotFound(): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: "ALERT_ENDPOINT_NOT_FOUND", retryable: false } },
    { status: 404, headers: { "cache-control": "no-store" } }
  );
}

export const GET = methodNotFound;
export const PUT = methodNotFound;
export const PATCH = methodNotFound;
export const DELETE = methodNotFound;
export const OPTIONS = methodNotFound;
