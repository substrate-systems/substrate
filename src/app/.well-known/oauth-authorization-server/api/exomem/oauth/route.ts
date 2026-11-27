import { NextResponse } from "next/server";
import { appOriginOnHost } from "@/lib/exomem/product-site";
import { buildAuthorizationServerMetadata } from "@/lib/exomem-hosted/oauth";
import { genericClientLaneEnabled } from "@/lib/exomem-hosted/oauth-store";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<NextResponse> {
  // A client discards metadata whose issuer differs from the one it fetched it under (RFC 8414
  // §3.3). Each app origin answers with its own issuer, so the company and product issuers both
  // stay valid while the web app and the gateway switch at different times, and after. Tokens
  // are opaque, the token, register and revoke routes answer on both hosts, and authorize sends
  // a browser on another host to the base origin.
  const issuerOrigin = appOriginOnHost(request.headers.get("host"), exomemPublicBaseUrlFromEnv());
  // Lane state that cannot be read is not advertised. The rest of the document
  // needs no database, so it is still served.
  const registrationEnabled = await genericClientLaneEnabled().catch(() => false);
  return NextResponse.json(
    buildAuthorizationServerMetadata(issuerOrigin, { registrationEnabled }),
    { headers: { "cache-control": "no-store" } }
  );
}
