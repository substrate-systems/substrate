import { NextResponse } from "next/server";
import { buildProtectedResourceMetadata } from "@/lib/exomem-hosted/oauth";
import { hostedIngressFromEnv } from "@/lib/exomem-hosted/hosted-ingress";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  const baseUrl = exomemPublicBaseUrlFromEnv();
  return NextResponse.json(
    buildProtectedResourceMetadata(baseUrl, hostedIngressFromEnv(baseUrl).resource),
    {
      headers: { "cache-control": "no-store" },
    }
  );
}
