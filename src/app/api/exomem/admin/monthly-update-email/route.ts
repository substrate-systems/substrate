import { NextRequest, NextResponse } from "next/server";
import { exomemErrors, ExomemHostedError } from "@/lib/exomem-hosted/errors";
import { emitAccessEvent } from "@/lib/exomem-hosted/http";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";
import { operatorTurnOnMonthlyUpdateEmail } from "@/lib/exomem-hosted/whats-new-digest/setting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Turns the "Monthly update email" setting on for one existing owner who asked
 * for it (`send-monthly-whats-new-digest`, Decided). The body is `{ "tenantId": <uuid> }`.
 * The owner's row keeps when it happened and the operator principal's digest,
 * and the log line names the tenant and the request. It never touches a
 * reviewer or a deleted account. It does not refuse an owner who said no before:
 * the answer's `earlierUnsubscribedAt` says when they unsubscribed, or is `null`,
 * and `earlierDismissedInvitation` says whether they dismissed Home's invitation.
 * A signup that left the switch off is not recorded, so it is not reported.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const tenantId = body.tenantId;
    if (
      typeof tenantId !== "string" ||
      !UUID.test(tenantId) ||
      Object.keys(body).some((key) => key !== "tenantId")
    ) {
      throw exomemErrors.invalidRequest();
    }
    const turnedOn = await operatorTurnOnMonthlyUpdateEmail(tenantId, operator.principalDigest);
    if (!turnedOn) {
      throw new ExomemHostedError({
        code: "WHATS_NEW_DIGEST_OWNER_UNKNOWN",
        status: 404,
        message: "no live owner account has that tenant id",
      });
    }
    operatorSuccessEvent(requestId);
    emitAccessEvent({
      event: "whats_new_digest.owner_turned_on",
      outcome: "succeeded",
      requestId,
      tenantId,
    });
    return NextResponse.json(
      {
        success: true,
        tenantId,
        monthlyUpdateEmail: true,
        earlierUnsubscribedAt: turnedOn.earlierUnsubscribedAt?.toISOString() ?? null,
        earlierDismissedInvitation: turnedOn.earlierDismissedInvitation,
        requestId,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
