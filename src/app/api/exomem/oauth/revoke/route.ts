import { NextResponse } from "next/server";
import { readOAuthForm, oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { revokeOAuthTokenForClient } from "@/lib/exomem-hosted/oauth-store";
import { tokenDigest } from "@/lib/exomem-hosted/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const form = await readOAuthForm(request);
    const digest = typeof form.token === "string" ? tokenDigest(form.token) : null;
    if (digest && form.client_id)
      await revokeOAuthTokenForClient({ tokenDigest: digest, clientId: form.client_id });
  } catch {
    // RFC 7009 makes invalid or unknown credentials indistinguishable from success.
  }
  return new NextResponse(null, { status: 200, headers: oauthNoStoreHeaders() });
}
