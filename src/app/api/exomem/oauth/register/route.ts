import { NextResponse } from "next/server";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { validateGenericClientRegistration } from "@/lib/exomem-hosted/oauth-client-admission";
import { clientNetworkKey, oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import { registerGenericMcpClient } from "@/lib/exomem-hosted/oauth-store";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_REGISTRATION_BODY_BYTES = 16 * 1024;

type RegisterRejectionStage = "rate_limit" | "request" | "registration" | "unhandled";

/**
 * The one answer to every refusal: a disabled lane, a rate limit, a malformed
 * or unsafe request, a full partition and a storage failure all look like a
 * route that does not exist. A difference between any two of them would tell
 * an anonymous caller whether the lane is enabled or how full it is.
 */
function refused(stage: RegisterRejectionStage): NextResponse {
  // The stage is for the operator; no request value is logged.
  console.error({ event: "exomem_oauth_register_rejection", stage });
  return new NextResponse(null, { status: 404, headers: oauthNoStoreHeaders() });
}

/** RFC 7591 dynamic client registration for generic MCP clients. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const allowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.oauthClientRegisterIp,
      clientNetworkKey(clientAddressKey(request) ?? "unavailable")
    );
    if (!allowed) return refused("rate_limit");
    let body: unknown;
    try {
      body = await readBoundedJsonRequest(request, MAX_REGISTRATION_BODY_BYTES);
    } catch {
      return refused("request");
    }
    const registration = validateGenericClientRegistration(body);
    if (!registration) return refused("request");
    const client = await registerGenericMcpClient(registration);
    if (!client) return refused("registration");
    // Only what this server honours for the client: no secret, the code flow,
    // and the redirects and name it stored.
    return NextResponse.json(
      {
        client_id: client.clientId,
        client_id_issued_at: Math.floor(client.issuedAt.getTime() / 1000),
        ...(client.clientName === null ? {} : { client_name: client.clientName }),
        redirect_uris: client.redirectUris,
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      { status: 201, headers: oauthNoStoreHeaders() }
    );
  } catch {
    return refused("unhandled");
  }
}
