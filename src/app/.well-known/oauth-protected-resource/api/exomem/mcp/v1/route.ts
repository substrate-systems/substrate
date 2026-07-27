import { NextResponse } from "next/server";
import { buildProtectedResourceMetadata } from "@/lib/exomem-hosted/oauth";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildProtectedResourceMetadata(exomemPublicBaseUrlFromEnv()), {
    headers: { "cache-control": "no-store" },
  });
}
