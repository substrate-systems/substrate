import { NextResponse } from "next/server";
import { parseAuthorizeParameters, validateAuthorizationRequest } from "@/lib/exomem-hosted/oauth";
import {
  createOAuthContinuation,
  oauthConfirmationHandle,
  resolveOAuthContinuation,
  setOAuthContinuationCookie,
} from "@/lib/exomem-hosted/oauth-continuity";
import { resolveApprovedOAuthClient } from "@/lib/exomem-hosted/oauth-store";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
  );
}

function rateLimited(): NextResponse {
  return NextResponse.json(
    { error: "temporarily_unavailable" },
    {
      status: 429,
      headers: {
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
        "retry-after": "600",
      },
    }
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const parameters = parseAuthorizeParameters(url.searchParams);
    if (parameters.response_type !== "code") return error();
    const clientId = parameters.client_id;
    if (!clientId || clientId.length > 2048) return error();
    const ipAllowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.oauthAuthorizeIp,
      clientAddressKey(request) ?? "unavailable"
    );
    if (!ipAllowed) return rateLimited();
    if (await resolveOAuthContinuation(request)) return error();
    const client = await resolveApprovedOAuthClient(clientId);
    if (!client) return error();
    if (!(await takeExomemRateLimit(EXOMEM_RATE_LIMITS.oauthAuthorizeClient, client.clientId)))
      return rateLimited();
    const resource = `${exomemPublicBaseUrlFromEnv()}/api/exomem/mcp/v1`;
    const authorization = validateAuthorizationRequest({
      client: { clientId: client.clientId, redirectUris: client.redirectUris },
      resource,
      requestedResource: parameters.resource,
      redirectUri: parameters.redirect_uri,
      scope: parameters.scope,
      state: parameters.state,
      codeChallenge: parameters.code_challenge,
      codeChallengeMethod: parameters.code_challenge_method,
    });
    const transaction = await createOAuthContinuation(authorization);
    if (!transaction) return error();
    const response = NextResponse.redirect(
      new URL(
        `/exomem/authorize?confirmation=${encodeURIComponent(oauthConfirmationHandle(transaction.transaction))}`,
        exomemPublicBaseUrlFromEnv()
      ),
      303
    );
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    setOAuthContinuationCookie(response, transaction);
    return response;
  } catch {
    return error();
  }
}
