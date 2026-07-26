import { NextResponse } from "next/server";
import { readOAuthForm, oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { revokeOAuthTokenForClient } from "@/lib/exomem-hosted/oauth-store";
import { digestSecret } from "@/lib/exomem-hosted/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REVOCATION_FIELDS = ["token", "token_type_hint", "client_id"] as const;
let revokeForClient = revokeOAuthTokenForClient;

export function __setRevokeOAuthTokenForClientForTests(
  value: typeof revokeOAuthTokenForClient | null
): void {
  revokeForClient = value ?? revokeOAuthTokenForClient;
}

function invalidRequest(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const form = await readOAuthForm(request, REVOCATION_FIELDS);
    if (!form.token || !form.client_id) return invalidRequest();
    await revokeForClient({
      tokenDigest: digestSecret(form.token),
      clientId: form.client_id,
    });
  } catch {
    return invalidRequest();
  }
  return new NextResponse(null, { status: 200, headers: oauthNoStoreHeaders() });
}
