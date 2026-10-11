import { NextResponse } from "next/server";
import { loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import {
  createCloudReviewerOAuthSessionAtomic,
  createCloudReviewerWebSessionAtomic,
  findCloudReviewerCredentialForAuthentication,
} from "@/lib/exomem-hosted/cloud-reviewer-access-store";
import { constantTimeSecretEqual, digestSecret } from "@/lib/exomem-hosted/security";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import {
  marketplaceReviewerAccessEnabled,
  authenticateMarketplaceReviewerCredential,
} from "@/lib/exomem-hosted/reviewer-access";
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

type ReviewerCredentialBody = { username: string; password: string; nonce?: unknown };

// Exactly `{username, password}` (web sign-in) or `{username, password, nonce}`
// (sign-in inside an app's OAuth request). Anything else fails like a wrong password.
function reviewerCredentialBody(body: unknown): ReviewerCredentialBody | null {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    ![2, 3].includes(Object.keys(body).length) ||
    Object.keys(body).some((key) => !["username", "password", "nonce"].includes(key)) ||
    typeof (body as { username?: unknown }).username !== "string" ||
    typeof (body as { password?: unknown }).password !== "string"
  ) {
    return null;
  }
  return body as ReviewerCredentialBody;
}

function authenticate(request: Request, body: ReviewerCredentialBody) {
  return authenticateMarketplaceReviewerCredential(
    {
      username: body.username,
      password: body.password,
      clientAddress: clientAddressKey(request) ?? "unknown",
    },
    {
      enabled: true,
      lookup: findCloudReviewerCredentialForAuthentication,
    }
  );
}

// An app-directory reviewer who opens the site directly. The credential goes
// through the same throttled Argon2 check as the app path, and the session row
// ends no later than the credential.
async function signInOnWeb(request: Request, body: ReviewerCredentialBody): Promise<NextResponse> {
  const credential = await authenticate(request, body);
  if (!credential) return authenticationFailed();
  const session = mintSessionMaterial();
  const created = await createCloudReviewerWebSessionAtomic({
    credentialId: credential.credentialId,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    expiresAt: session.expiresAt,
  });
  if (!created) return authenticationFailed();
  const response = NextResponse.json(
    { success: true, status: "authenticated", destination: "/exomem/home" },
    { headers }
  );
  applySessionCookies(response, { ...session, expiresAt: new Date(created.expiresAt) });
  return response;
}

async function signInForApp(request: Request, body: ReviewerCredentialBody): Promise<NextResponse> {
  const continuation = await resolveOAuthContinuation(request);
  const transaction = oauthContinuationToken(request);
  const transactionDigest = oauthContinuationDigest(request);
  if (!continuation || !transaction || !transactionDigest) return authenticationFailed();
  const nonce = oauthFormNonceFromRequest(request);
  if (
    continuation.resource !== loadExomemCloudResource().mcpUrl ||
    !nonce ||
    typeof body.nonce !== "string" ||
    !constantTimeSecretEqual(nonce, body.nonce) ||
    !constantTimeSecretEqual(
      digestSecret(nonce).toString("base64url"),
      continuation.formNonceDigest.toString("base64url")
    )
  )
    return authenticationFailed();
  const credential = await authenticate(request, body);
  if (!credential) return authenticationFailed();
  const session = mintSessionMaterial();
  const created = await createCloudReviewerOAuthSessionAtomic({
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
}

export async function POST(request: Request): Promise<NextResponse> {
  if (!marketplaceReviewerAccessEnabled()) return authenticationFailed();
  try {
    validatePublicAccessRequest(request);
    const body = reviewerCredentialBody(await readBoundedJsonRequest(request, 4096));
    if (!body || request.headers.get("origin") !== new URL(request.url).origin) {
      return authenticationFailed();
    }
    return "nonce" in body ? await signInForApp(request, body) : await signInOnWeb(request, body);
  } catch {
    return authenticationFailed();
  }
}
