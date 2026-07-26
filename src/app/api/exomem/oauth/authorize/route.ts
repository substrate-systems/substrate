import { NextResponse } from "next/server";
import { validateAuthorizationRequest } from "@/lib/exomem-hosted/oauth";
import {
  createOAuthContinuation,
  setOAuthContinuationCookie,
} from "@/lib/exomem-hosted/oauth-continuity";
import { resolveApprovedOAuthClient } from "@/lib/exomem-hosted/oauth-store";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function error(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: { "cache-control": "no-store" } }
  );
}

export async function GET(request: Request): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    if (!clientId || clientId.length > 2048) return error();
    const client = await resolveApprovedOAuthClient(clientId);
    if (!client) return error();
    const resource = `${exomemPublicBaseUrlFromEnv()}/api/exomem/mcp/v1`;
    const authorization = validateAuthorizationRequest({
      client: { clientId: client.clientId, redirectUris: client.redirectUris },
      resource,
      requestedResource: url.searchParams.get("resource"),
      redirectUri: url.searchParams.get("redirect_uri") ?? "",
      scope: url.searchParams.get("scope") ?? "",
      state: url.searchParams.get("state") ?? "",
      codeChallenge: url.searchParams.get("code_challenge") ?? "",
      codeChallengeMethod: url.searchParams.get("code_challenge_method") ?? "",
    });
    const transaction = await createOAuthContinuation(authorization);
    if (!transaction) return error();
    const response = NextResponse.redirect(
      new URL("/exomem/authorize", exomemPublicBaseUrlFromEnv())
    );
    response.headers.set("cache-control", "no-store");
    setOAuthContinuationCookie(response, transaction);
    return response;
  } catch {
    return error();
  }
}
