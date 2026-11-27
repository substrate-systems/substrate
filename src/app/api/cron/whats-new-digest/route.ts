import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import { emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { runWhatsNewDigestSelection } from "@/lib/exomem-hosted/whats-new-digest/run";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily: builds the previous month's What's new selection and leaves it for the
 * operator's approval (`send-monthly-whats-new-digest`, D4). Safe to repeat, and
 * a missed day heals on the next run. It sends no email.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  if (!verifyCronAuth(req).ok) {
    emitAccessEvent({
      event: "whats_new_digest.select",
      outcome: "denied",
      requestId,
      errorCode: "CRON_AUTH_REJECTED",
    });
    return NextResponse.json(
      { success: false },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
  try {
    const summary = await runWhatsNewDigestSelection();
    emitAccessEvent({ event: "whats_new_digest.select", outcome: "succeeded", requestId });
    return NextResponse.json(
      { success: true, ...summary },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    emitAccessEvent({
      event: "whats_new_digest.select",
      outcome: "failed",
      requestId,
      errorCode: "WHATS_NEW_DIGEST_RUN_FAILED",
    });
    return NextResponse.json(
      { success: false, error: { code: "WHATS_NEW_DIGEST_RUN_FAILED" } },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
