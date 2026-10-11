import { NextResponse } from "next/server";
import { buildAuthorizationServerMetadata } from "@/lib/exomem-hosted/oauth";
import { genericClientLaneEnabled } from "@/lib/exomem-hosted/oauth-store";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<NextResponse> {
  // Lane state that cannot be read is not advertised. The rest of the document
  // needs no database, so it is still served.
  const registrationEnabled = await genericClientLaneEnabled().catch(() => false);
  return NextResponse.json(
    buildAuthorizationServerMetadata(exomemPublicBaseUrlFromEnv(), { registrationEnabled }),
    { headers: { "cache-control": "no-store" } }
  );
}
