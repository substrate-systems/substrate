/**
 * Who calls an owner API under /api/exomem/cloud: the owner's Cloud OAuth
 * bearer (the CLI and the MCP gateway) or the owner's browser session (Home).
 * Imports and exports resolve the caller here and nowhere else, so one rule
 * decides how a bearer is checked and when a session needs its CSRF proof.
 */

import { loadExomemCloudResource, type EnvironmentSource } from "./cloud-config";
import { findCloudOAuthAccessToken } from "./cloud-oauth";
import { exomemErrors } from "./errors";
import { parseBearerAuthorization } from "./oauth";
import { digestSecret } from "./security";
import { resolveExomemSession, validateMutationRequest } from "./sessions";

export type CloudOwnerPrincipal =
  | {
      via: "bearer";
      userId: string;
      tenantId: string;
      cellId: string;
      cellDesiredState: string;
    }
  // A session names no cell: a caller that needs one looks it up from the tenant.
  | { via: "session"; userId: string; tenantId: string };

/**
 * A request that carries an `Authorization` header is a bearer request and
 * never falls back to its cookies. The bearer must be an access token for the
 * Cloud resource with both Cloud scopes (design D2). A bearer is no ambient
 * credential, so it takes no CSRF proof; a session does on every mutation.
 */
export async function resolveCloudOwnerPrincipal(
  request: Request,
  env: EnvironmentSource = process.env
): Promise<CloudOwnerPrincipal> {
  if (request.headers.has("authorization")) {
    const bearer = parseBearerAuthorization(request.headers.get("authorization"));
    const token = bearer
      ? await findCloudOAuthAccessToken(digestSecret(bearer), loadExomemCloudResource(env).mcpUrl)
      : null;
    if (!token) throw exomemErrors.accessTokenInvalid();
    if (!token.scopes.includes("exomem.read") || !token.scopes.includes("exomem.write")) {
      throw exomemErrors.entitlementDenied();
    }
    return {
      via: "bearer",
      userId: token.userId,
      tenantId: token.tenantId,
      cellId: token.cellId,
      cellDesiredState: token.cellDesiredState,
    };
  }
  const session = await resolveExomemSession(request);
  if (request.method !== "GET" && request.method !== "HEAD")
    validateMutationRequest(request, session);
  return { via: "session", userId: session.userId, tenantId: session.tenantId };
}
