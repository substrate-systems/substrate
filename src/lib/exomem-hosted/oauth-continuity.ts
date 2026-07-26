import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";
import { mintAuthorizationCode, type AuthorizationCodeRecord } from "./oauth";
import {
  createAuthorizationTransaction,
  findPendingOAuthAuthorization,
  type PendingOAuthAuthorization,
} from "./oauth-store";
import {
  decryptSecret,
  controlPlaneKeyFromEnv,
  constantTimeSecretEqual,
  digestSecret,
  encryptSecret,
  generateExternalToken,
  tokenDigest,
} from "./security";

export const EXOMEM_OAUTH_CONTINUITY_COOKIE = "exomem_oauth_tx";
export const EXOMEM_OAUTH_FORM_NONCE_COOKIE = "exomem_oauth_form_nonce";
const OAUTH_TRANSACTION_TTL_MS = 10 * 60 * 1000;

export type OAuthContinuation = PendingOAuthAuthorization & { state: string };

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  const part = header.split(";").find((value) => value.trim().startsWith(`${name}=`));
  return part ? part.slice(part.indexOf("=") + 1).trim() || null : null;
}

function continuationBinding(input: {
  transaction: string;
  formNonce: string;
  clientId: string;
  scopes: string[];
}): Buffer {
  return createHmac("sha256", controlPlaneKeyFromEnv())
    .update("exomem-oauth-continuation:v1\0", "utf8")
    .update(input.transaction, "utf8")
    .update("\0", "utf8")
    .update(input.formNonce, "utf8")
    .update("\0", "utf8")
    .update(input.clientId, "utf8")
    .update("\0", "utf8")
    .update([...input.scopes].sort().join(" "), "utf8")
    .digest();
}

export async function createOAuthContinuation(input: {
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  state: string;
  codeChallenge: string;
  offlineAccess: boolean;
}): Promise<{ transaction: string; formNonce: string } | null> {
  const transaction = generateExternalToken();
  const formNonce = generateExternalToken();
  const expiresAt = new Date(Date.now() + OAUTH_TRANSACTION_TTL_MS);
  const scopes = [...input.scopes, ...(input.offlineAccess ? ["offline_access"] : [])];
  const transactionDigest = digestSecret(transaction);
  const binding = continuationBinding({
    transaction,
    formNonce,
    clientId: input.clientId,
    scopes,
  });
  const created = await createAuthorizationTransaction({
    transactionDigest,
    stateDigest: digestSecret(input.state),
    stateEnvelope: encryptSecret(
      JSON.stringify({
        version: 1,
        state: input.state,
        transactionDigest: transactionDigest.toString("base64url"),
        continuationBinding: binding.toString("base64url"),
      })
    ),
    formNonceDigest: digestSecret(formNonce),
    continuationBinding: binding,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource: input.resource,
    scopes,
    pkceChallenge: input.codeChallenge,
    expiresAt,
  });
  return created ? { transaction, formNonce } : null;
}

export function setOAuthContinuationCookie(
  response: NextResponse,
  continuation: { transaction: string; formNonce: string }
): void {
  response.cookies.set(EXOMEM_OAUTH_CONTINUITY_COOKIE, continuation.transaction, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/exomem",
    maxAge: Math.floor(OAUTH_TRANSACTION_TTL_MS / 1000),
  });
  response.cookies.set(EXOMEM_OAUTH_FORM_NONCE_COOKIE, continuation.formNonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/exomem/authorize",
    maxAge: Math.floor(OAUTH_TRANSACTION_TTL_MS / 1000),
  });
  response.cookies.set(EXOMEM_OAUTH_FORM_NONCE_COOKIE, continuation.formNonce, {
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
  response.cookies.set(EXOMEM_OAUTH_FORM_NONCE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/exomem/authorize",
    maxAge: 0,
  });
  response.cookies.set(EXOMEM_OAUTH_FORM_NONCE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/exomem",
    maxAge: 0,
  });
}

export function oauthFormNonceFromCookie(value: string | undefined): string | null {
  return value && tokenDigest(value) ? value : null;
}

export function oauthFormNonceFromRequest(request: Request): string | null {
  return oauthFormNonceFromCookie(
    cookieValue(request, EXOMEM_OAUTH_FORM_NONCE_COOKIE) ?? undefined
  );
}

export function oauthContinuationDigest(request: Request): Buffer | null {
  const transaction = cookieValue(request, EXOMEM_OAUTH_CONTINUITY_COOKIE);
  return transaction ? tokenDigest(transaction) : null;
}

export function oauthContinuationToken(request: Request): string | null {
  return cookieValue(request, EXOMEM_OAUTH_CONTINUITY_COOKIE);
}

export async function resolveOAuthContinuation(
  request: Request
): Promise<OAuthContinuation | null> {
  const digest = oauthContinuationDigest(request);
  if (!digest) return null;
  const pending = await findPendingOAuthAuthorization(digest);
  if (!pending) return null;
  try {
    const value = JSON.parse(decryptSecret(pending.stateEnvelope).reveal()) as {
      state?: unknown;
      transactionDigest?: unknown;
      continuationBinding?: unknown;
    };
    if (
      typeof value.state !== "string" ||
      !value.state ||
      typeof value.transactionDigest !== "string" ||
      typeof value.continuationBinding !== "string" ||
      !constantTimeSecretEqual(digest.toString("base64url"), value.transactionDigest) ||
      !constantTimeSecretEqual(
        pending.continuationBinding.toString("base64url"),
        value.continuationBinding
      ) ||
      !constantTimeSecretEqual(
        digestSecret(value.state).toString("base64url"),
        pending.stateDigest.toString("base64url")
      )
    ) {
      return null;
    }
    return { ...pending, state: value.state };
  } catch {
    return null;
  }
}

export function validateOAuthContinuationNonce(input: {
  continuation: OAuthContinuation;
  transaction: string;
  formNonce: string;
}): boolean {
  const nonceDigest = tokenDigest(input.formNonce);
  if (!nonceDigest) return false;
  const binding = continuationBinding({
    transaction: input.transaction,
    formNonce: input.formNonce,
    clientId: input.continuation.clientId,
    scopes: input.continuation.scopes,
  });
  return (
    constantTimeSecretEqual(
      nonceDigest.toString("base64url"),
      input.continuation.formNonceDigest.toString("base64url")
    ) &&
    constantTimeSecretEqual(
      binding.toString("base64url"),
      input.continuation.continuationBinding.toString("base64url")
    )
  );
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
