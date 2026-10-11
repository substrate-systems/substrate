import { NextRequest, NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  newRequestId,
  operatorErrorResponse,
  operatorSuccessEvent,
  readOperatorJsonRecord,
  requireRateLimitedExomemOperator,
} from "@/lib/exomem-hosted/operator-admin";
import {
  generateMarketplaceReviewerCredential,
  hashMarketplaceReviewerPassword,
  type MarketplaceReviewerProvider,
  marketplaceReviewerAccessEnabled,
} from "@/lib/exomem-hosted/reviewer-access";
import {
  createOrRotateCloudReviewerCredentialAtomic,
  getCloudReviewerCredentialStatus,
  revokeCloudReviewerCredentialAtomic,
} from "@/lib/exomem-hosted/cloud-reviewer-access-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// The one credential kind this route manages (add-cloud-reviewer-access).
const CLOUD_PROVIDER_REVIEW = "cloud_provider_review";

function provider(value: unknown): MarketplaceReviewerProvider | null {
  return value === "openai" || value === "anthropic" ? value : null;
}

function credentialInput(body: Record<string, unknown>) {
  if (
    typeof body.fixtureVersion !== "string" ||
    !body.fixtureVersion.trim() ||
    body.fixtureVersion.length > 128 ||
    typeof body.fixturePayloadDigest !== "string" ||
    !SHA256_HEX.test(body.fixturePayloadDigest) ||
    typeof body.expiresAt !== "string"
  ) {
    return null;
  }
  const expiresAt = new Date(body.expiresAt);
  return Number.isFinite(expiresAt.getTime())
    ? {
        fixtureVersion: body.fixtureVersion.trim(),
        fixturePayloadDigest: body.fixturePayloadDigest,
        expiresAt,
      }
    : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const params = new URL(request.url).searchParams;
    const selected = provider(params.get("provider"));
    if (params.get("credentialKind") !== CLOUD_PROVIDER_REVIEW || !selected) {
      throw exomemErrors.invalidRequest();
    }
    const status = await getCloudReviewerCredentialStatus(selected);
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, status, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const shared = credentialInput(body);
    if (!shared) throw exomemErrors.invalidRequest();
    if (body.credentialKind !== CLOUD_PROVIDER_REVIEW || !marketplaceReviewerAccessEnabled())
      throw exomemErrors.invalidRequest();
    const selected = provider(body.provider);
    if (
      !selected ||
      typeof body.ownerUserId !== "string" ||
      !UUID.test(body.ownerUserId) ||
      typeof body.tenantId !== "string" ||
      !UUID.test(body.tenantId)
    ) {
      throw exomemErrors.invalidRequest();
    }
    const credential = generateMarketplaceReviewerCredential();
    const created = await createOrRotateCloudReviewerCredentialAtomic({
      provider: selected,
      usernameDigest: credential.usernameDigest,
      passwordHash: await hashMarketplaceReviewerPassword(credential.password),
      ownerUserId: body.ownerUserId,
      tenantId: body.tenantId,
      fixtureVersion: shared.fixtureVersion,
      fixturePayloadDigest: shared.fixturePayloadDigest,
      expiresAt: shared.expiresAt,
      operatorPrincipalDigest: operator.principalDigest,
    });
    if (!created) throw exomemErrors.invalidRequest();
    operatorSuccessEvent(requestId);
    return NextResponse.json(
      {
        success: true,
        credentialKind: CLOUD_PROVIDER_REVIEW,
        provider: selected,
        fixtureVersion: shared.fixtureVersion,
        fixturePayloadDigest: shared.fixturePayloadDigest,
        expiresAt: shared.expiresAt.toISOString(),
        credentials: { username: credential.username, password: credential.password },
        requestId,
      },
      { status: 201, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
    );
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const operator = await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const selected = provider(body.provider);
    if (body.credentialKind !== CLOUD_PROVIDER_REVIEW || !selected) {
      throw exomemErrors.invalidRequest();
    }
    const revoked = await revokeCloudReviewerCredentialAtomic({
      provider: selected,
      operatorPrincipalDigest: operator.principalDigest,
    });
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, revoked: revoked > 0, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
