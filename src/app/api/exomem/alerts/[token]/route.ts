import { NextRequest, NextResponse } from "next/server";
import { safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { emitAccessEvent, newRequestId, readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import {
  ALERT_MAX_BODY_BYTES,
  ALERT_TRANSITION_HEADER,
  deliverAlertNotification,
  listUndeliveredAlerts,
  parseAlertTransition,
  recordAlertTransition,
  verifyAlertToken,
  type AlertTransition,
} from "@/lib/exomem-hosted/alert-receiver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Terminates the K3s scheduler alert sender.
 *
 * The sender refuses redirects and requires a 2xx within ten seconds, so this
 * route is exact (no trailing slash, no rewrite) and commits before it answers.
 * It lives on Vercel deliberately: an alert about K3s being unreachable is
 * worthless if it has to traverse K3s to arrive.
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
    emitAccessEvent({ event: "alerts.transition.denied", outcome: "denied", requestId });
    return safeErrorResponse(error, requestId);
  }

  let accepted: boolean;
  try {
    // Durability boundary: everything after this point may fail without
    // costing us the transition.
    ({ accepted } = await recordAlertTransition(transition));
  } catch {
    // Not yet durable, so the sender must retry. Its own retry policy is one
    // attempt with a maximum of two, which is why this stays a 5xx rather than
    // a polite 2xx that would silently drop the alert.
    emitAccessEvent({
      event: "alerts.transition.denied",
      outcome: "failed",
      requestId,
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

  if (accepted) {
    const outcome = await deliverAlertNotification(transition);
    emitAccessEvent({
      event: outcome.delivered ? "alerts.notification.delivered" : "alerts.notification.failed",
      outcome: outcome.delivered ? "succeeded" : "failed",
      requestId,
      alertJob: transition.job,
      alertName: transition.alert,
      transitionHash: transition.transitionId,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    });
    // Alerts recur, so draining a bounded slice of the undelivered backlog on
    // each accepted transition is enough to self-heal a Brevo outage without
    // taking a Hobby cron slot or amending the pinned K3s schedule contract.
    await flushUndeliveredBacklog(requestId, transition.transitionId);
  }

  return NextResponse.json(
    { success: true, accepted },
    { status: 200, headers: { "cache-control": "no-store" } }
  );
}

async function flushUndeliveredBacklog(requestId: string, justHandled: string): Promise<void> {
  let backlog: AlertTransition[];
  try {
    backlog = await listUndeliveredAlerts(5);
  } catch {
    return;
  }
  for (const pending of backlog) {
    if (pending.transitionId === justHandled) continue;
    const outcome = await deliverAlertNotification(pending);
    emitAccessEvent({
      event: outcome.delivered ? "alerts.notification.delivered" : "alerts.notification.failed",
      outcome: outcome.delivered ? "succeeded" : "failed",
      requestId,
      alertJob: pending.job,
      alertName: pending.alert,
      transitionHash: pending.transitionId,
      ...(outcome.errorCode ? { errorCode: outcome.errorCode } : {}),
    });
    if (!outcome.delivered) return;
  }
}
