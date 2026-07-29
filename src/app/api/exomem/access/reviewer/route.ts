import { NextResponse } from "next/server";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import {
  marketplaceReviewerAccessEnabled,
  authenticateMarketplaceReviewerCredential,
} from "@/lib/exomem-hosted/reviewer-access";
import {
  createMarketplaceReviewerOAuthSessionAtomic,
  findMarketplaceReviewerCredentialForAuthentication,
} from "@/lib/exomem-hosted/reviewer-access-store";
import {
  oauthConfirmationHandle,
  oauthContinuationDigest,
  oauthContinuationToken,
  resolveOAuthContinuation,
} from "@/lib/exomem-hosted/oauth-continuity";
import { clientAddressKey } from "@/lib/exomem-hosted/rate-limit";
import {
  applySessionCookies,
  mintSessionMaterial,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function authenticationFailed(): NextResponse {
  return NextResponse.json(
    { success: false, error: "authentication_failed" },
    { status: 401, headers }
  );
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!marketplaceReviewerAccessEnabled()) return authenticationFailed();
  try {
    validatePublicAccessRequest(request);
    const continuation = await resolveOAuthContinuation(request);
    const transaction = oauthContinuationToken(request);
    const transactionDigest = oauthContinuationDigest(request);
    if (!continuation || !transaction || !transactionDigest) return authenticationFailed();
    const body = await readBoundedJsonRequest(request, 4096);
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 2 ||
      typeof (body as { username?: unknown }).username !== "string" ||
      typeof (body as { password?: unknown }).password !== "string"
    ) {
      return authenticationFailed();
    }
    const credential = await authenticateMarketplaceReviewerCredential(
      {
        username: (body as { username: string }).username,
        password: (body as { password: string }).password,
        clientAddress: clientAddressKey(request) ?? "unknown",
      },
      {
        enabled: true,
        lookup: findMarketplaceReviewerCredentialForAuthentication,
      }
    );
    if (!credential) return authenticationFailed();
    const session = mintSessionMaterial();
    const created = await createMarketplaceReviewerOAuthSessionAtomic({
      credentialId: credential.credentialId,
      transactionDigest,
      sessionDigest: session.sessionDigest,
      csrfDigest: session.csrfDigest,
      expiresAt: session.expiresAt,
    });
    if (!created) return authenticationFailed();
    const response = NextResponse.json(
      {
        success: true,
        status: "authenticated",
        destination: `/exomem/authorize?confirmation=${encodeURIComponent(oauthConfirmationHandle(transaction))}`,
      },
      { headers }
    );
    applySessionCookies(response, session);
    return response;
  } catch {
    return authenticationFailed();
  }
}
