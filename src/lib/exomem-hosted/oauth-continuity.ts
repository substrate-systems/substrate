import { NextResponse } from "next/server";
import { mintAuthorizationCode, type AuthorizationCodeRecord } from "./oauth";
import {
  createAuthorizationTransaction,
  findPendingOAuthAuthorization,
  type PendingOAuthAuthorization,
} from "./oauth-store";
import {
  decryptSecret,
  digestSecret,
  encryptSecret,
  generateExternalToken,
  tokenDigest,
} from "./security";

export const EXOMEM_OAUTH_CONTINUITY_COOKIE = "exomem_oauth_tx";
const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export type OAuthContinuation = PendingOAuthAuthorization & { state: string };

export async function createOAuthContinuation(input: {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
}): Promise<string | null> {
  const transaction = generateExternalToken();
  const expiresAt = new Date(Date.now() + OAUTH_TRANSACTION_TTL_MS);
  const created = await createAuthorizationTransaction({
    transactionDigest: digestSecret(transaction),
    stateDigest: digestSecret(input.state),
    stateEnvelope: encryptSecret(JSON.stringify({ state: input.state })),
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scopes: input.scopes,
    pkceChallenge: input.codeChallenge,
    expiresAt,
  });
  return created ? transaction : null;
}

export function setOAuthContinuationCookie(response: NextResponse, transaction: string): void {
  response.cookies.set(EXOMEM_OAUTH_CONTINUITY_COOKIE, transaction, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/exomem",
    maxAge: Math.floor(OAUTH_TRANSACTION_TTL_MS / 1000),
  });
}

export function clearOAuthContinuationCookie(response: NextResponse): void {
  response.cookies.set(EXOMEM_OAUTH_CONTINUITY_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/exomem",
    maxAge: 0,
  });
}

function cookieValue(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const part = header
    .split(";")
    .find((value) => value.trim().startsWith(`${EXOMEM_OAUTH_CONTINUITY_COOKIE}=`));
  return part ? part.slice(part.indexOf("=") + 1).trim() || null : null;
}

export function oauthContinuationDigest(request: Request): Buffer | null {
  const transaction = cookieValue(request);
  return transaction ? tokenDigest(transaction) : null;
}

export async function resolveOAuthContinuation(
  request: Request
): Promise<OAuthContinuation | null> {
  const digest = oauthContinuationDigest(request);
  if (!digest) return null;
  const pending = await findPendingOAuthAuthorization(digest);
  if (!pending) return null;
  try {
    const value = JSON.parse(decryptSecret(pending.stateEnvelope).reveal()) as { state?: unknown };
    if (typeof value.state !== "string" || !value.state) return null;
    return { ...pending, state: value.state };
  } catch {
    return null;
  }
}

export function mintContinuationCode(continuation: OAuthContinuation): {
  code: string;
  codeDigest: Buffer;
  codeExpiresAt: Date;
} {
  const material = mintAuthorizationCode({
    clientId: continuation.clientId,
    redirectUri: continuation.redirectUri,
    resource: continuation.resource,
    scopes: continuation.scopes.filter(
      (scope): scope is "exomem.read" | "exomem.write" =>
        scope === "exomem.read" || scope === "exomem.write"
    ),
    offlineAccess: continuation.scopes.includes("offline_access"),
    codeChallenge: "",
  } satisfies Omit<AuthorizationCodeRecord, "expiresAt" | "offlineAccess"> & {
    offlineAccess: boolean;
  });
  return {
    code: material.code,
    codeDigest: material.codeDigest,
    codeExpiresAt: material.record.expiresAt,
  };
}

export function authorizationRedirect(continuation: OAuthContinuation, code: string): string {
  const redirect = new URL(continuation.redirectUri);
  redirect.searchParams.set("code", code);
  redirect.searchParams.set("state", continuation.state);
  return redirect.toString();
}
