import { NextResponse } from "next/server";
import { bearerChallenge, mcpAuthenticateMeta } from "@/lib/exomem-hosted/oauth";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function unauthorized(): NextResponse {
  const baseUrl = exomemPublicBaseUrlFromEnv();
  return NextResponse.json(
    { _meta: mcpAuthenticateMeta(baseUrl) },
    {
      status: 401,
      headers: { "www-authenticate": bearerChallenge(baseUrl), "cache-control": "no-store" },
    }
  );
}

export async function GET(): Promise<NextResponse> {
  return unauthorized();
}

export async function POST(): Promise<NextResponse> {
  return unauthorized();
}
