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
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";
import { tokenDigest } from "@/lib/exomem-hosted/security";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TOKEN_FIELDS = [
  "grant_type",
  "code",
  "client_id",
  "redirect_uri",
  "code_verifier",
  "resource",
  "refresh_token",
] as const;

function hasExactFields(form: Record<string, string>, fields: readonly string[]): boolean {
  const keys = Object.keys(form);
  return keys.length === fields.length && keys.every((key) => fields.includes(key));
}

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

function rateLimited(): NextResponse {
  return NextResponse.json(
    { error: "temporarily_unavailable" },
    {
      status: 429,
      headers: {
        ...oauthNoStoreHeaders(),
        "retry-after": String(EXOMEM_RATE_LIMITS.oauthTokenIp.windowSeconds),
      },
    }
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
    const allowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.oauthTokenIp,
      clientAddressKey(request) ?? "unavailable"
    );
    if (!allowed) return rateLimited();
    const form = await readOAuthForm(request, TOKEN_FIELDS);
    const resource = `${exomemPublicBaseUrlFromEnv()}/api/exomem/mcp/v1`;
    if (form.grant_type === "authorization_code") {
      if (
        !hasExactFields(form, [
          "grant_type",
          "code",
          "client_id",
          "redirect_uri",
          "code_verifier",
          "resource",
        ]) ||
        !form.code ||
        !form.client_id ||
        !form.redirect_uri ||
        !form.code_verifier ||
        form.resource !== resource
      )
        return invalidRequest();
      if (!tokenDigest(form.code) || !isPkceVerifier(form.code_verifier)) return invalidGrant();
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
      if (
        !hasExactFields(form, ["grant_type", "refresh_token", "client_id", "resource"]) ||
        !form.refresh_token ||
        !form.client_id ||
        form.resource !== resource
      )
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
