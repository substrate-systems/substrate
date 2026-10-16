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
    // The only record of what a pass sent, retried, gave up on or let expire:
    // counts, no content, for each lane that did any of it, logged before a
    // failed lane turns the answer into a 503.
    const worked = {
      ...(magicLinks.status === "fulfilled" &&
      magicLinks.value.claimed + magicLinks.value.expired > 0
        ? { magicLinks: magicLinks.value }
        : {}),
      ...(outbox.status === "fulfilled" && outbox.value.claimed > 0
        ? { outbox: outbox.value }
        : {}),
    };
    if (Object.keys(worked).length > 0) {
      console.info(JSON.stringify({ event: "exomem.access_delivery.drained", ...worked }));
    }
    if (magicLinks.status === "rejected") console.error("exomem: sign-in link lane failed");
    if (outbox.status === "rejected") console.error("exomem: email outbox lane failed");
    if (magicLinks.status === "rejected" || outbox.status === "rejected") {
      throw new Error("EXOMEM_ACCESS_DELIVERY_LANE_FAILED");
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
