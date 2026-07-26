import { NextResponse } from "next/server";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import {
  isPkceVerifier,
  mintOpaqueTokenMaterial,
  OAuthProtocolError,
  pkceS256,
} from "@/lib/exomem-hosted/oauth";
import { readOAuthForm, oauthNoStoreHeaders } from "@/lib/exomem-hosted/oauth-http";
import {
  issueOAuthTokensFromCodeAtomic,
  rotateOAuthRefreshTokenAtomic,
} from "@/lib/exomem-hosted/oauth-store";
import { tokenDigest } from "@/lib/exomem-hosted/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function invalidGrant(): NextResponse {
  return NextResponse.json(
    { error: "invalid_grant" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

function invalidRequest(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

function tokenResponse(input: {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
}): NextResponse {
  return NextResponse.json(
    {
      access_token: input.accessToken,
      token_type: "Bearer",
      expires_in: 15 * 60,
      scope: input.scopes.join(" "),
      ...(input.refreshToken ? { refresh_token: input.refreshToken } : {}),
    },
    { headers: oauthNoStoreHeaders() }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const form = await readOAuthForm(request);
    const resource = `${exomemPublicBaseUrlFromEnv()}/api/exomem/mcp/v1`;
    if (form.grant_type === "authorization_code") {
      if (
        !form.code ||
        !form.client_id ||
        !form.redirect_uri ||
        !form.code_verifier ||
        form.resource !== resource ||
        !tokenDigest(form.code) ||
        !isPkceVerifier(form.code_verifier)
      )
        return invalidRequest();
      const material = mintOpaqueTokenMaterial({ refreshAllowed: true });
      const issued = await issueOAuthTokensFromCodeAtomic({
        codeDigest: tokenDigest(form.code)!,
        clientId: form.client_id,
        redirectUri: form.redirect_uri,
        resource,
        pkceChallenge: pkceS256(form.code_verifier),
        refreshDigest: material.refreshTokenDigest!,
        refreshExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS),
        accessDigest: material.accessTokenDigest,
        accessExpiresAt: material.accessTokenExpiresAt,
      });
      if (!issued) return invalidGrant();
      return tokenResponse({
        accessToken: material.accessToken.reveal(),
        ...(issued.refreshInserted ? { refreshToken: material.refreshToken!.reveal() } : {}),
        scopes: issued.scopes,
      });
    }
    if (form.grant_type === "refresh_token") {
      if (!form.refresh_token || !form.client_id || form.resource !== resource)
        return invalidRequest();
      const refreshDigest = tokenDigest(form.refresh_token);
      if (!refreshDigest) return invalidGrant();
      const material = mintOpaqueTokenMaterial({ refreshAllowed: true });
      const issued = await rotateOAuthRefreshTokenAtomic({
        refreshDigest,
        replacementRefreshDigest: material.refreshTokenDigest!,
        accessDigest: material.accessTokenDigest,
        accessExpiresAt: material.accessTokenExpiresAt,
        clientId: form.client_id,
        resource,
      });
      if (!issued) return invalidGrant();
      return tokenResponse({
        accessToken: material.accessToken.reveal(),
        refreshToken: material.refreshToken!.reveal(),
        scopes: issued.scopes,
      });
    }
    return invalidRequest();
  } catch (error) {
    return error instanceof OAuthProtocolError ? invalidGrant() : invalidRequest();
  }
}
