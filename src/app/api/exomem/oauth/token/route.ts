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

type TokenRejectionStage =
  | "grant_type"
  | "code_fields"
  | "code_shape"
  | "code_exchange"
  | "refresh_fields"
  | "refresh_shape"
  | "refresh_rotation"
  | "protocol_error"
  | "unhandled";

// `invalid_grant` is the correct answer to the caller and tells the operator
// nothing: a consumed code, an expired code, a PKCE mismatch, a redirect_uri
// mismatch and a fail-closed contract-state refusal are one response, one status
// and one access log line. On 2026-08-22 a real connector's exchange failed here
// and attributing it meant reading a seventy-line SQL predicate and querying rows
// by hand, because this route logged nothing at all -- while the sibling authorize
// and authorize/complete routes both name their rejection stage.
//
// Shape, never values. The code, the verifier, the refresh token and the client
// secret material stay out of the log; `client_id` is a public identifier that is
// already on every access log line, and the grant type is chosen by the caller.
function logTokenRejection(
  stage: TokenRejectionStage,
  diagnostics?: Record<string, boolean | number | string>
): void {
  console.error({
    event: "exomem_oauth_token_rejection",
    stage,
    ...(diagnostics ?? {}),
  });
}

function invalidGrant(
  stage: TokenRejectionStage,
  diagnostics?: Record<string, boolean | number | string>
): NextResponse {
  logTokenRejection(stage, diagnostics);
  return NextResponse.json(
    { error: "invalid_grant" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

function invalidRequest(
  stage: TokenRejectionStage,
  diagnostics?: Record<string, boolean | number | string>
): NextResponse {
  logTokenRejection(stage, diagnostics);
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
    const form = await readOAuthForm(request, TOKEN_FIELDS, { ignoreUnrecognized: true });
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
        // The resource mismatch is the one a client gets wrong on its own, and it
        // is indistinguishable from a missing field without this.
        return invalidRequest("code_fields", {
          field_names: Object.keys(form).sort().join(",") || "none",
          resource_matches: form.resource === resource,
        });
      if (!tokenDigest(form.code) || !isPkceVerifier(form.code_verifier))
        return invalidGrant("code_shape", {
          code_wellformed: !!tokenDigest(form.code),
          verifier_wellformed: isPkceVerifier(form.code_verifier),
        });
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
      // A null here is the whole admission predicate answering no: consumed or
      // expired code, redirect_uri or PKCE mismatch, revoked grant, blocked
      // account, or fail-closed contract state. It cannot say which without
      // re-querying, so it names the client and redirect it was asked about --
      // enough to find the code row by hand and evaluate the predicate against it.
      if (!issued)
        return invalidGrant("code_exchange", {
          client_id: form.client_id,
          redirect_uri: form.redirect_uri,
        });
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
        return invalidRequest("refresh_fields", {
          field_names: Object.keys(form).sort().join(",") || "none",
          resource_matches: form.resource === resource,
        });
      const refreshDigest = tokenDigest(form.refresh_token);
      if (!refreshDigest) return invalidGrant("refresh_shape");
      const material = mintOpaqueTokenMaterial({ refreshAllowed: true });
      const issued = await rotateOAuthRefreshTokenAtomic({
        refreshDigest,
        replacementRefreshDigest: material.refreshTokenDigest!,
        accessDigest: material.accessTokenDigest,
        accessExpiresAt: material.accessTokenExpiresAt,
        clientId: form.client_id,
        resource,
      });
      // Rotation also answers null for a replayed refresh token, which revokes
      // the family -- so this line is the operator's only sight of a replay.
      if (!issued) return invalidGrant("refresh_rotation", { client_id: form.client_id });
      return tokenResponse({
        accessToken: material.accessToken.reveal(),
        refreshToken: material.refreshToken!.reveal(),
        scopes: issued.scopes,
      });
    }
    return invalidRequest("grant_type", {
      grant_type: form.grant_type?.slice(0, 64) ?? "absent",
    });
  } catch (error) {
    return error instanceof OAuthProtocolError
      ? invalidGrant("protocol_error")
      : invalidRequest("unhandled");
  }
}
