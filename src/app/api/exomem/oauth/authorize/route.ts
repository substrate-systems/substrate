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

type AuthorizeStage =
  | "ip_rate_limit"
  | "client_parameter_parsing"
  | "client_resolution"
  | "redirect_validation"
  | "post_callback";

type AuthorizeErrorClass = "error" | "non_error";

const SAFE_NODE_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "ENOTCONN",
  "EPIPE",
  "ETIMEDOUT",
]);
const POSTGRES_SQLSTATE = /^[0-9A-Z]{5}$/;

function error(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
  );
}

function temporarilyUnavailable(): NextResponse {
  return NextResponse.json(
    { error: "temporarily_unavailable" },
    { status: 503, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
  );
}

function safeErrorCode(caught: unknown): string | undefined {
  if (!(caught instanceof Error)) return undefined;
  const code = (caught as Error & { code?: unknown }).code;
  if (typeof code !== "string") return undefined;
  return POSTGRES_SQLSTATE.test(code) || SAFE_NODE_ERROR_CODES.has(code) ? code : undefined;
}

function logOperationalFailure(stage: AuthorizeStage, caught: unknown): void {
  const errorClass: AuthorizeErrorClass = caught instanceof Error ? "error" : "non_error";
  const errorCode = safeErrorCode(caught);
  console.error({
    event: "exomem_oauth_authorize_operational_failure",
    stage,
    error_class: errorClass,
    ...(errorCode ? { error_code: errorCode } : {}),
  });
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
  let stage: AuthorizeStage = "ip_rate_limit";
  try {
    const url = new URL(request.url);
    const ipAllowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.oauthAuthorizeIp,
      clientAddressKey(request) ?? "unavailable"
    );
    if (!ipAllowed) return rateLimited();
    stage = "client_parameter_parsing";
    const clientId = parameter(url.searchParams, "client_id");
    if (!clientId || clientId.length > 2048) return error();
    stage = "client_resolution";
    const client = await resolveApprovedOAuthClient(clientId);
    if (!client) return error();
    stage = "redirect_validation";
    const redirectUri = parameter(url.searchParams, "redirect_uri");
    if (!redirectUri || !client.redirectUris.includes(redirectUri)) return error();
    callback = { redirectUri, state: callbackState(url.searchParams) };
    stage = "post_callback";
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
    if (!(caught instanceof OAuthProtocolError)) logOperationalFailure(stage, caught);
    return callback
      ? authorizationError(
          callback.redirectUri,
          callback.state,
          caught instanceof OAuthProtocolError ? "invalid_request" : "temporarily_unavailable"
        )
      : caught instanceof OAuthProtocolError
        ? error()
        : temporarilyUnavailable();
  }
}
