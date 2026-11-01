import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import { emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import {
  evaluateKeyWatcherHeartbeat,
  runAlertNotificationPass,
} from "@/lib/exomem-hosted/alert-receiver";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Daily missed-run check for the object-store key watcher.
 *
 * Vercel runs it, not the cluster, so a stopped watcher or a silenced cluster
 * still produces `KEY_WATCHER_STALE`. The response carries no identifiers.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  if (!verifyCronAuth(req).ok) {
    // A missing CRON_SECRET fails closed and would otherwise stop the check
    // without a trace.
    emitAccessEvent({ event: "alerts.key_watcher.check", outcome: "denied", requestId, errorCode: "CRON_AUTH_REJECTED" });
    return NextResponse.json({ success: false }, { status: 401, headers: { "cache-control": "no-store" } });
  }
  try {
    const heartbeat = await evaluateKeyWatcherHeartbeat(new Date());
    if (!heartbeat.enabled) {
      emitAccessEvent({ event: "alerts.key_watcher.check", outcome: "succeeded", requestId, errorCode: "KEY_WATCHER_NOT_CONFIGURED" });
      return NextResponse.json({ success: true, enabled: false }, { headers: { "cache-control": "no-store" } });
    }
    const outcomes = await runAlertNotificationPass({ first: heartbeat.transitionId, limit: 5 });
    emitAccessEvent({
      event: "alerts.key_watcher.check",
      outcome: "succeeded",
      requestId,
      alertJob: "b2-key-watcher",
      alertName: heartbeat.stale ? "KEY_WATCHER_STALE" : "KEY_WATCHER_FRESH",
    });
    return NextResponse.json(
      {
        success: true,
        enabled: true,
        stale: heartbeat.stale,
        notified: outcomes.filter((outcome) => outcome.delivered && !outcome.skipped).length,
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    emitAccessEvent({ event: "alerts.key_watcher.check", outcome: "failed", requestId, errorCode: "KEY_WATCHER_CHECK_UNAVAILABLE" });
    return NextResponse.json(
      { success: false, error: { code: "KEY_WATCHER_CHECK_UNAVAILABLE" } },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
