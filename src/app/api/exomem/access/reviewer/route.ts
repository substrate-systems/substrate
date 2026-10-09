import { NextResponse } from "next/server";
import { exomemCloudEnabled, loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import {
  createCloudReviewerOAuthSessionAtomic,
  findCloudReviewerCredentialForAuthentication,
} from "@/lib/exomem-hosted/cloud-reviewer-access-store";
import { constantTimeSecretEqual, digestSecret } from "@/lib/exomem-hosted/security";
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
  oauthConsentPath,
  oauthContinuationDigest,
  oauthContinuationToken,
  resolveOAuthContinuation,
  oauthFormNonceFromRequest,
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
  const cloud = exomemCloudEnabled();
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
      ![2, 3].includes(Object.keys(body).length) ||
      Object.keys(body).some((key) => !["username", "password", "nonce"].includes(key)) ||
      typeof (body as { username?: unknown }).username !== "string" ||
      typeof (body as { password?: unknown }).password !== "string"
    ) {
      return authenticationFailed();
    }
    if (cloud) {
      const nonce = oauthFormNonceFromRequest(request);
      const submittedNonce = (body as { nonce?: unknown }).nonce;
      if (
        request.headers.get("origin") !== new URL(request.url).origin ||
        continuation.resource !== loadExomemCloudResource().mcpUrl ||
        !nonce ||
        typeof submittedNonce !== "string" ||
        !constantTimeSecretEqual(nonce, submittedNonce) ||
        !constantTimeSecretEqual(
          digestSecret(nonce).toString("base64url"),
          continuation.formNonceDigest.toString("base64url")
        )
      )
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
        lookup: cloud
          ? findCloudReviewerCredentialForAuthentication
          : findMarketplaceReviewerCredentialForAuthentication,
      }
    );
    if (!credential) return authenticationFailed();
    const session = mintSessionMaterial();
    const created = await (
      cloud ? createCloudReviewerOAuthSessionAtomic : createMarketplaceReviewerOAuthSessionAtomic
    )({
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
        destination: oauthConsentPath(transaction),
      },
      { headers }
    );
    const credentialExpiresAt = new Date(credential.expiresAt);
    applySessionCookies(response, {
      ...session,
      expiresAt:
        credentialExpiresAt.getTime() < session.expiresAt.getTime()
          ? credentialExpiresAt
          : session.expiresAt,
    });
    return response;
  } catch {
    return authenticationFailed();
  }
}
