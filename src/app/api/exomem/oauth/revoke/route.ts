import { NextResponse } from "next/server";
import { readOAuthForm, oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { revokeOAuthTokenForClient } from "@/lib/exomem-hosted/oauth-store";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";
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

function rateLimited(): NextResponse {
  return NextResponse.json(
    { error: "temporarily_unavailable" },
    {
      status: 429,
      headers: {
        ...oauthNoStoreHeaders(),
        "retry-after": String(EXOMEM_RATE_LIMITS.oauthRevokeIp.windowSeconds),
      },
    }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const allowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.oauthRevokeIp,
      clientAddressKey(request) ?? "unavailable"
    );
    if (!allowed) return rateLimited();
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
