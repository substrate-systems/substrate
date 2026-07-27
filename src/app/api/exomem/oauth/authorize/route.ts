import { NextResponse } from "next/server";
import {
  OAuthProtocolError,
  parseAuthorizeParameters,
  validateAuthorizationRequest,
} from "@/lib/exomem-hosted/oauth";
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

function parameter(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 1 ? values[0] : null;
}

function callbackState(params: URLSearchParams): string | null {
  const state = parameter(params, "state");
  return state !== null && state.length <= 2048 ? state : null;
}

function authorizationError(
  redirectUri: string,
  state: string | null,
  errorCode: "invalid_request" | "temporarily_unavailable"
): NextResponse {
  try {
    const redirect = new URL(redirectUri);
    redirect.searchParams.set("error", errorCode);
    if (state !== null) redirect.searchParams.set("state", state);
    const response = NextResponse.redirect(redirect, 303);
    response.headers.set("cache-control", "no-store");
    response.headers.set("referrer-policy", "no-referrer");
    return response;
  } catch {
    return error();
  }
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
  let callback: { redirectUri: string; state: string | null } | null = null;
  try {
    const url = new URL(request.url);
    const ipAllowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.oauthAuthorizeIp,
      clientAddressKey(request) ?? "unavailable"
    );
    if (!ipAllowed) return rateLimited();
    const clientId = parameter(url.searchParams, "client_id");
    if (!clientId || clientId.length > 2048) return error();
    const client = await resolveApprovedOAuthClient(clientId);
    if (!client) return error();
    const redirectUri = parameter(url.searchParams, "redirect_uri");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return error();
    callback = { redirectUri, state: callbackState(url.searchParams) };
    const parameters = parseAuthorizeParameters(url.searchParams);
    if (parameters.response_type !== "code")
      return authorizationError(callback.redirectUri, callback.state, "invalid_request");
    if (await resolveOAuthContinuation(request))
      return authorizationError(callback.redirectUri, callback.state, "invalid_request");
    if (!(await takeExomemRateLimit(EXOMEM_RATE_LIMITS.oauthAuthorizeClient, client.clientId)))
      return authorizationError(callback.redirectUri, callback.state, "temporarily_unavailable");
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
    if (!transaction)
      return authorizationError(callback.redirectUri, callback.state, "temporarily_unavailable");
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
  } catch (caught) {
    return callback
      ? authorizationError(
          callback.redirectUri,
          callback.state,
          caught instanceof OAuthProtocolError ? "invalid_request" : "temporarily_unavailable"
        )
      : error();
  }
}
