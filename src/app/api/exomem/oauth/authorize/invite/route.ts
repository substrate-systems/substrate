import { NextResponse } from "next/server";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { admitFirstOAuthInviteAtomic } from "@/lib/exomem-hosted/oauth-store";
import {
  authorizationRedirect,
  clearOAuthContinuationCookie,
  mintContinuationCode,
  oauthContinuationDigest,
  resolveOAuthContinuation,
} from "@/lib/exomem-hosted/oauth-continuity";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import {
  applySessionCookies,
  mintSessionMaterial,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<NextResponse> {
  const continuation = await resolveOAuthContinuation(request);
  const transactionDigest = oauthContinuationDigest(request);
  if (!continuation || !transactionDigest)
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  try {
    validatePublicAccessRequest(request);
    const body = await readBoundedJsonRequest(request, 4096);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof (body as { token?: unknown }).token !== "string"
    ) {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    const inviteDigest = tokenDigest((body as { token: string }).token);
    if (!inviteDigest) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    const session = mintSessionMaterial();
    const code = mintContinuationCode(continuation);
    const admitted = await admitFirstOAuthInviteAtomic({
      inviteDigest,
      transactionDigest,
      sessionDigest: session.sessionDigest,
      csrfDigest: session.csrfDigest,
      sessionExpiresAt: session.expiresAt,
      codeDigest: code.codeDigest,
      codeExpiresAt: code.codeExpiresAt,
    });
    if (!admitted) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    const response = NextResponse.redirect(authorizationRedirect(continuation, code.code));
    response.headers.set("cache-control", "no-store");
    applySessionCookies(response, session);
    clearOAuthContinuationCookie(response);
    return response;
  } catch {
    return NextResponse.json(
      { error: "access_denied" },
      { status: 403, headers: { "cache-control": "no-store" } }
    );
  }
}
