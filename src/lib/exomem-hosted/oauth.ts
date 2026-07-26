import { createHash } from "node:crypto";
import { parseExomemPublicBaseUrl } from "./public-origin";
import {
  digestSecret,
  generateExternalToken,
  type RandomBytesSource,
  SensitiveSecret,
  tokenDigest,
} from "./security";

const MCP_PATH = "/api/exomem/mcp/v1";
const OAUTH_PATH = "/api/exomem/oauth";
const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
const ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000;
const PKCE_VALUE = /^[A-Za-z0-9_-]{43,128}$/;
const SUPPORTED_SCOPES = new Set(["exomem.read", "exomem.write", "offline_access"]);

export type OAuthClient = {
  clientId: string;
  redirectUris: readonly string[];
};

export type CimdMetadata = {
  client_id: string;
  redirect_uris: string[];
  token_endpoint_auth_method: "none";
};

export type AuthorizationRequest = {
  client: OAuthClient;
  resource: string;
  requestedResource: string | null | undefined;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
};

export type ValidAuthorizationRequest = {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: Array<"exomem.read" | "exomem.write">;
  offlineAccess: boolean;
  state: string;
  codeChallenge: string;
};

export class OAuthProtocolError extends Error {
  readonly code: "OAUTH_INVALID_REQUEST" | "OAUTH_INVALID_GRANT";

  constructor(code: OAuthProtocolError["code"]) {
    super(code);
    this.name = "OAuthProtocolError";
    this.code = code;
  }
}

function paths(baseUrl: string): { issuer: string; resource: string } {
  const origin = parseExomemPublicBaseUrl(baseUrl);
  return { issuer: `${origin}${OAUTH_PATH}`, resource: `${origin}${MCP_PATH}` };
}

export function buildProtectedResourceMetadata(baseUrl: string): Record<string, unknown> {
  const { issuer, resource } = paths(baseUrl);
  return {
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["exomem.read", "exomem.write"],
  };
}

export function buildAuthorizationServerMetadata(baseUrl: string): Record<string, unknown> {
  const { issuer } = paths(baseUrl);
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    revocation_endpoint: `${issuer}/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    client_id_metadata_document_supported: true,
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["exomem.read", "exomem.write", "offline_access"],
  };
}

export function protectedResourceMetadataUrl(baseUrl: string): string {
  return `${parseExomemPublicBaseUrl(baseUrl)}/.well-known/oauth-protected-resource/api/exomem/mcp/v1`;
}

export function bearerChallenge(baseUrl: string): string {
  return `Bearer resource_metadata="${protectedResourceMetadataUrl(baseUrl)}"`;
}

export function mcpAuthenticateMeta(baseUrl: string): { "mcp/www_authenticate": string[] } {
  return { "mcp/www_authenticate": [bearerChallenge(baseUrl)] };
}

/** Returns a raw credential only when it appears as the sole bearer header value. */
export function parseBearerAuthorization(value: string | null): string | null {
  if (!value) return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,})$/i.exec(value);
  return match ? match[1] : null;
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function isPkceVerifier(value: string): boolean {
  return PKCE_VALUE.test(value);
}

function invalidRequest(): never {
  throw new OAuthProtocolError("OAUTH_INVALID_REQUEST");
}

export function validateAuthorizationRequest(
  input: AuthorizationRequest
): ValidAuthorizationRequest {
  if (
    input.requestedResource !== input.resource ||
    !input.client.redirectUris.includes(input.redirectUri) ||
    !input.state ||
    input.state.length > 2048 ||
    input.codeChallengeMethod !== "S256" ||
    !PKCE_VALUE.test(input.codeChallenge)
  ) {
    return invalidRequest();
  }
  const scopes = [...new Set(input.scope.split(" ").filter(Boolean))];
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !SUPPORTED_SCOPES.has(scope)) ||
    !scopes.some((scope) => scope === "exomem.read" || scope === "exomem.write")
  ) {
    return invalidRequest();
  }
  return {
    clientId: input.client.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scopes: scopes.filter(
      (scope): scope is "exomem.read" | "exomem.write" =>
        scope === "exomem.read" || scope === "exomem.write"
    ),
    offlineAccess: scopes.includes("offline_access"),
    state: input.state,
    codeChallenge: input.codeChallenge,
  };
}

/**
 * CIMD is compatibility-only for explicitly promoted hosts. Fetching, DNS
 * resolution, redirect following, and caching stay at the storage boundary;
 * this parser deliberately accepts only the already bounded response.
 */
export function validateCimdMetadata(
  input: { clientId: string; allowedHosts: readonly string[]; metadata: CimdMetadata },
  approvedRedirectUris: readonly string[]
): OAuthClient {
  let clientUrl: URL;
  try {
    clientUrl = new URL(input.clientId);
  } catch {
    return invalidRequest();
  }
  if (
    clientUrl.protocol !== "https:" ||
    clientUrl.username ||
    clientUrl.password ||
    clientUrl.search ||
    clientUrl.hash ||
    !input.allowedHosts.includes(clientUrl.hostname.toLowerCase()) ||
    input.metadata.client_id !== input.clientId ||
    input.metadata.token_endpoint_auth_method !== "none" ||
    !Array.isArray(input.metadata.redirect_uris) ||
    input.metadata.redirect_uris.length === 0 ||
    input.metadata.redirect_uris.some((redirectUri) => !approvedRedirectUris.includes(redirectUri))
  ) {
    return invalidRequest();
  }
  return { clientId: input.clientId, redirectUris: input.metadata.redirect_uris };
}

export type AuthorizationCodeRecord = {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: Array<"exomem.read" | "exomem.write">;
  offlineAccess: boolean;
  codeChallenge: string;
  expiresAt: Date;
};

export function mintAuthorizationCode(
  input: Omit<AuthorizationCodeRecord, "expiresAt" | "offlineAccess"> & {
    offlineAccess?: boolean;
    now?: Date;
    randomBytes?: RandomBytesSource;
  }
): { code: string; codeDigest: Buffer; record: AuthorizationCodeRecord } {
  const code = generateExternalToken(input.randomBytes);
  return {
    code,
    codeDigest: digestSecret(code),
    record: {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource: input.resource,
      scopes: input.scopes,
      offlineAccess: input.offlineAccess ?? false,
      codeChallenge: input.codeChallenge,
      expiresAt: new Date((input.now ?? new Date()).getTime() + AUTHORIZATION_CODE_TTL_MS),
    },
  };
}

export type OpaqueTokenMaterial = {
  accessToken: SensitiveSecret;
  accessTokenDigest: Buffer;
  accessTokenExpiresAt: Date;
  refreshToken?: SensitiveSecret;
  refreshTokenDigest?: Buffer;
};

export function mintOpaqueTokenMaterial(input: {
  now?: Date;
  randomBytes?: RandomBytesSource;
  refreshAllowed?: boolean;
}): OpaqueTokenMaterial {
  const accessToken = generateExternalToken(input.randomBytes);
  const refreshToken =
    input.refreshAllowed === false ? undefined : generateExternalToken(input.randomBytes);
  return {
    accessToken: new SensitiveSecret(accessToken),
    accessTokenDigest: digestSecret(accessToken),
    accessTokenExpiresAt: new Date((input.now ?? new Date()).getTime() + ACCESS_TOKEN_TTL_MS),
    ...(refreshToken
      ? {
          refreshToken: new SensitiveSecret(refreshToken),
          refreshTokenDigest: digestSecret(refreshToken),
        }
      : {}),
  };
}

export async function exchangeAuthorizationCode(
  input: {
    code: string;
    clientId: string;
    redirectUri: string;
    resource: string;
    codeVerifier: string;
  },
  dependencies: {
    consumeAuthorizationCode: (input: {
      codeDigest: Buffer;
      clientId: string;
      redirectUri: string;
      resource: string;
      pkceChallenge: string;
    }) => Promise<AuthorizationCodeRecord | null>;
    now?: () => Date;
    randomBytes?: RandomBytesSource;
  }
): Promise<
  OpaqueTokenMaterial & Pick<AuthorizationCodeRecord, "clientId" | "resource" | "scopes">
> {
  const codeDigest = tokenDigest(input.code);
  if (!codeDigest || !PKCE_VALUE.test(input.codeVerifier)) {
    throw new OAuthProtocolError("OAUTH_INVALID_GRANT");
  }
  const record = await dependencies.consumeAuthorizationCode({
    codeDigest,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    pkceChallenge: pkceS256(input.codeVerifier),
  });
  const now = dependencies.now?.() ?? new Date();
  if (
    !record ||
    record.expiresAt <= now ||
    record.clientId !== input.clientId ||
    record.redirectUri !== input.redirectUri ||
    record.resource !== input.resource ||
    record.codeChallenge !== pkceS256(input.codeVerifier)
  ) {
    throw new OAuthProtocolError("OAUTH_INVALID_GRANT");
  }
  return {
    ...mintOpaqueTokenMaterial({
      now,
      randomBytes: dependencies.randomBytes,
      refreshAllowed: record.offlineAccess,
    }),
    clientId: record.clientId,
    resource: record.resource,
    scopes: record.scopes,
  };
}

export async function rotateRefreshToken(
  input: { refreshToken: string; clientId: string; resource: string },
  dependencies: {
    rotate: (input: {
      refreshDigest: Buffer;
      replacementRefreshDigest: Buffer;
      accessDigest: Buffer;
      accessExpiresAt: Date;
      clientId: string;
      resource: string;
    }) => Promise<{
      clientId: string;
      resource: string;
      scopes: Array<"exomem.read" | "exomem.write">;
    } | null>;
    now?: () => Date;
    randomBytes?: RandomBytesSource;
  }
): Promise<
  OpaqueTokenMaterial & {
    clientId: string;
    resource: string;
    scopes: Array<"exomem.read" | "exomem.write">;
  }
> {
  const refreshDigest = tokenDigest(input.refreshToken);
  if (!refreshDigest) throw new OAuthProtocolError("OAUTH_INVALID_GRANT");
  const now = dependencies.now?.() ?? new Date();
  const material = mintOpaqueTokenMaterial({
    now,
    randomBytes: dependencies.randomBytes,
    refreshAllowed: true,
  });
  const record = await dependencies.rotate({
    refreshDigest,
    replacementRefreshDigest: material.refreshTokenDigest!,
    accessDigest: material.accessTokenDigest,
    accessExpiresAt: material.accessTokenExpiresAt,
    clientId: input.clientId,
    resource: input.resource,
  });
  if (!record || record.clientId !== input.clientId || record.resource !== input.resource) {
    throw new OAuthProtocolError("OAUTH_INVALID_GRANT");
  }
  return { ...material, ...record };
}
