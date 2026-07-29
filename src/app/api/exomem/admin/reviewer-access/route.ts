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
} from "@/lib/exomem-hosted/reviewer-access";
import {
  createOrRotateMarketplaceReviewerCredentialAtomic,
  getMarketplaceReviewerCredentialStatus,
  revokeMarketplaceReviewerCredentialAtomic,
} from "@/lib/exomem-hosted/reviewer-access-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function provider(value: unknown): MarketplaceReviewerProvider | null {
  return value === "openai" || value === "anthropic" ? value : null;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const selected = provider(new URL(request.url).searchParams.get("provider"));
    if (!selected) throw exomemErrors.invalidRequest();
    const status = await getMarketplaceReviewerCredentialStatus(selected);
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
    const selected = provider(body.provider);
    if (
      !selected ||
      typeof body.ownerUserId !== "string" ||
      !UUID.test(body.ownerUserId) ||
      typeof body.tenantId !== "string" ||
      !UUID.test(body.tenantId) ||
      typeof body.fixtureVersion !== "string" ||
      !body.fixtureVersion.trim() ||
      body.fixtureVersion.length > 128 ||
      typeof body.fixturePayloadDigest !== "string" ||
      !SHA256_HEX.test(body.fixturePayloadDigest) ||
      typeof body.expiresAt !== "string"
    ) {
      throw exomemErrors.invalidRequest();
    }
    const expiresAt = new Date(body.expiresAt);
    const credential = generateMarketplaceReviewerCredential();
    const created = await createOrRotateMarketplaceReviewerCredentialAtomic({
      provider: selected,
      usernameDigest: credential.usernameDigest,
      passwordHash: await hashMarketplaceReviewerPassword(credential.password),
      ownerUserId: body.ownerUserId,
      tenantId: body.tenantId,
      fixtureVersion: body.fixtureVersion.trim(),
      fixturePayloadDigest: body.fixturePayloadDigest,
      expiresAt,
      operatorPrincipalDigest: operator.principalDigest,
    });
    if (!created) throw exomemErrors.invalidRequest();
    operatorSuccessEvent(requestId);
    return NextResponse.json(
      {
        success: true,
        provider: selected,
        fixtureVersion: body.fixtureVersion.trim(),
        fixturePayloadDigest: body.fixturePayloadDigest,
        expiresAt: expiresAt.toISOString(),
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
    if (!selected) throw exomemErrors.invalidRequest();
    const revoked = await revokeMarketplaceReviewerCredentialAtomic({
      provider: selected,
      operatorPrincipalDigest: operator.principalDigest,
    });
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, revoked: revoked > 0, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
