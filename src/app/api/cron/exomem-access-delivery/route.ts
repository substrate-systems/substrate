import { NextRequest, NextResponse } from "next/server";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import { drainMagicLinkDeliveries } from "@/lib/exomem-hosted/access-delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!verifyCronAuth(request).ok) {
    return NextResponse.json(
      { success: false, error: { code: "UNAUTHENTICATED" } },
      { status: 401, headers: { "cache-control": "no-store" } }
    );
  }
  try {
    const result = await drainMagicLinkDeliveries({ maxMessages: 5, timeBudgetMs: 8_000 });
    return NextResponse.json(
      { success: true, result },
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
