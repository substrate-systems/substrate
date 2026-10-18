import { NextRequest, NextResponse } from "next/server";
import { resolveInboxProvider } from "@/lib/exomem-hosted/inbox-provider";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An optional public-domain hint; requesting a sign-in link never waits for this route. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const domain = request.nextUrl.searchParams.get("domain") ?? "";
  return NextResponse.json(
    { providerId: await resolveInboxProvider(domain) },
    { headers: { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" } }
  );
}
