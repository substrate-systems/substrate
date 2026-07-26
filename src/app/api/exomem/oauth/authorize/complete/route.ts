import { NextResponse } from "next/server";
import { attachExistingOwnerAuthorizationAtomic } from "@/lib/exomem-hosted/oauth-store";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthContinuationDigest,
  resolveOAuthContinuation,
} from "@/lib/exomem-hosted/oauth-continuity";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  if (!continuation || !transactionDigest)
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try {
    const session = await resolveExomemSession(request);
    const code = mintContinuationCode(continuation);
    const attached = await attachExistingOwnerAuthorizationAtomic({
      sessionId: session.id,
      transactionDigest,
      codeDigest: code.codeDigest,
      codeExpiresAt: code.codeExpiresAt,
    });
    if (!attached) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    const response = NextResponse.redirect(authorizationRedirect(continuation, code.code));
    response.headers.set("cache-control", "no-store");
    clearOAuthContinuationCookie(response);
    return response;
  } catch {
    return NextResponse.json(
      { error: "access_denied" },
      { status: 403, headers: { "cache-control": "no-store" } }
    );
  }
}
