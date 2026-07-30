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
  createInternalCanaryReviewerCredentialAtomic,
  getInternalCanaryReviewerCredentialStatus,
  getMarketplaceReviewerCredentialStatus,
  revokeInternalCanaryReviewerCredentialAtomic,
  revokeMarketplaceReviewerCredentialAtomic,
} from "@/lib/exomem-hosted/reviewer-access-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

function provider(value: unknown): MarketplaceReviewerProvider | null {
  return value === "openai" || value === "anthropic" ? value : null;
}

type InternalCanarySelector = {
  platform: "claude" | "openai";
  tenantId: string;
  candidateId: string;
  assignmentId: string;
  assignmentGeneration: number;
  stagedClientReleaseId: string;
  oauthClientId: string;
};

function internalCanarySelector(body: Record<string, unknown>): InternalCanarySelector | null {
  return body.platform === "claude" || body.platform === "openai"
    ? typeof body.tenantId === "string" &&
      UUID.test(body.tenantId) &&
      typeof body.candidateId === "string" &&
      UUID.test(body.candidateId) &&
      typeof body.assignmentId === "string" &&
      UUID.test(body.assignmentId) &&
      Number.isSafeInteger(body.assignmentGeneration) &&
      (body.assignmentGeneration as number) > 0 &&
      typeof body.stagedClientReleaseId === "string" &&
      UUID.test(body.stagedClientReleaseId) &&
      typeof body.oauthClientId === "string" &&
      UUID.test(body.oauthClientId)
      ? {
          platform: body.platform,
          tenantId: body.tenantId,
          candidateId: body.candidateId,
          assignmentId: body.assignmentId,
          assignmentGeneration: body.assignmentGeneration as number,
          stagedClientReleaseId: body.stagedClientReleaseId,
          oauthClientId: body.oauthClientId,
        }
      : null
    : null;
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
    const kind = params.get("credentialKind");
    const internalSelector = internalCanarySelector({
      platform: params.get("platform"),
      tenantId: params.get("tenantId"),
      candidateId: params.get("candidateId"),
      assignmentId: params.get("assignmentId"),
      assignmentGeneration: Number(params.get("assignmentGeneration")),
      stagedClientReleaseId: params.get("stagedClientReleaseId"),
      oauthClientId: params.get("oauthClientId"),
    });
    const status =
      kind === "internal_canary"
        ? await getInternalCanaryReviewerCredentialStatus(
            internalSelector ?? (() => { throw exomemErrors.invalidRequest(); })()
          )
        : kind === null || kind === "provider_review"
          ? await getMarketplaceReviewerCredentialStatus(
              provider(params.get("provider")) ?? (() => { throw exomemErrors.invalidRequest(); })()
            )
          : (() => {
              throw exomemErrors.invalidRequest();
            })();
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
    const credential = generateMarketplaceReviewerCredential();
    if (body.credentialKind === "internal_canary") {
      const selector = internalCanarySelector(body);
      if (!selector) throw exomemErrors.invalidRequest();
      const created = await createInternalCanaryReviewerCredentialAtomic({
        ...selector,
        usernameDigest: credential.usernameDigest,
        passwordHash: await hashMarketplaceReviewerPassword(credential.password),
        ...shared,
        operatorPrincipalDigest: operator.principalDigest,
      });
      if (!created) throw exomemErrors.invalidRequest();
      operatorSuccessEvent(requestId);
      return NextResponse.json(
        {
          success: true,
          credentialKind: "internal_canary",
          platform: selector.platform,
          fixtureVersion: shared.fixtureVersion,
          fixturePayloadDigest: shared.fixturePayloadDigest,
          expiresAt: created.expiresAt,
          credentials: { username: credential.username, password: credential.password },
          requestId,
        },
        { status: 201, headers: { "cache-control": "no-store", "referrer-policy": "no-referrer" } }
      );
    }
    if (body.credentialKind !== undefined && body.credentialKind !== "provider_review")
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
    const created = await createOrRotateMarketplaceReviewerCredentialAtomic({
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
    if (body.credentialKind === "internal_canary") {
      const selector = internalCanarySelector(body);
      if (!selector) throw exomemErrors.invalidRequest();
      const revoked = await revokeInternalCanaryReviewerCredentialAtomic({
        ...selector,
        operatorPrincipalDigest: operator.principalDigest,
      });
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, revoked: revoked > 0, requestId });
    }
    if (body.credentialKind !== undefined && body.credentialKind !== "provider_review")
      throw exomemErrors.invalidRequest();
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
