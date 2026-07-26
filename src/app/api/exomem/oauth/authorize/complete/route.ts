import { NextResponse } from "next/server";
import { attachExistingOwnerAuthorizationAtomic } from "@/lib/exomem-hosted/oauth-store";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthContinuationDigest,
  oauthContinuationToken,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { oauthNoStoreHeaders, readOAuthForm } from "@/lib/exomem-hosted/oauth-http";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function invalidRequest(): NextResponse {
  return NextResponse.json(
    { error: "invalid_request" },
    { status: 400, headers: oauthNoStoreHeaders() }
  );
}

function accessDenied(): NextResponse {
  return NextResponse.json(
    { error: "access_denied" },
    { status: 403, headers: oauthNoStoreHeaders() }
  );
}

function validOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return (
      ["http:", "https:"].includes(parsed.protocol) &&
      parsed.host.toLowerCase() === host.toLowerCase()
    );
  } catch {
    return false;
  }
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!validOrigin(request)) return invalidRequest();
  let form: Record<string, string>;
  try {
    form = await readOAuthForm(request, ["nonce"]);
  } catch {
    return invalidRequest();
  }
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  const transaction = oauthContinuationToken(request);
  if (
    !continuation ||
    !transactionDigest ||
    !transaction ||
    !form.nonce ||
    !validateOAuthContinuationNonce({ continuation, transaction, formNonce: form.nonce })
  ) {
    return invalidRequest();
  }
  try {
    const session = await resolveExomemSession(request);
    const code = mintContinuationCode(continuation);
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: session.id,
      transactionDigest,
      codeDigest: code.codeDigest,
      codeExpiresAt: code.codeExpiresAt,
    });
    if (!attached) return accessDenied();
    const response = NextResponse.redirect(authorizationRedirect(continuation, code.code), 303);
    for (const [name, value] of Object.entries(oauthNoStoreHeaders()))
      response.headers.set(name, value);
    clearOAuthContinuationCookie(response);
    return response;
  } catch {
    return accessDenied();
  }
}
