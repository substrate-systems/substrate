import { NextRequest, NextResponse } from "next/server";
import { verifyHostedSchedulerAuth } from "@/lib/exomem-hosted/scheduler-auth";
import { drainMagicLinkDeliveries } from "@/lib/exomem-hosted/access-delivery";
import { drainExomemEmailOutbox } from "@/lib/exomem-hosted/email-outbox";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyHostedSchedulerAuth(request).ok) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
  try {
    // Sign-in links and the email outbox drain side by side: a provider or
    // database failure in one must not hold back the other's mail.
    const [magicLinks, outbox] = await Promise.allSettled([
      drainMagicLinkDeliveries({ maxMessages: 5, timeBudgetMs: 8_000 }),
      drainExomemEmailOutbox({ maxMessages: 20, timeBudgetMs: 8_000 }),
    ]);
    if (magicLinks.status === "rejected" || outbox.status === "rejected") {
      throw new Error("EXOMEM_ACCESS_DELIVERY_LANE_FAILED");
    }
    // The only record of what a pass sent, retried, gave up on or let expire:
    // counts, no content, and only for a pass that did any of it.
    if (magicLinks.value.claimed + magicLinks.value.expired + outbox.value.claimed > 0) {
      console.info(
        JSON.stringify({
          event: "exomem.access_delivery.drained",
          magicLinks: magicLinks.value,
          outbox: outbox.value,
        })
      );
    }
    return NextResponse.json(
      { success: true, result: magicLinks.value, outbox: outbox.value },
      { headers: { "cache-control": "no-store" } }
    );
  } catch {
    return NextResponse.json(
      {
        success: false,
        error: { code: "ACCESS_DELIVERY_UNAVAILABLE", retryable: true },
      },
      { status: 503, headers: { "cache-control": "no-store" } }
    );
  }
}
