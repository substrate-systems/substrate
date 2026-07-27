import { NextResponse } from "next/server";
import { buildAuthorizationServerMetadata } from "@/lib/exomem-hosted/oauth";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(buildAuthorizationServerMetadata(exomemPublicBaseUrlFromEnv()), {
    headers: { "cache-control": "no-store" },
  });
}
