import { NextRequest, NextResponse } from "next/server";
import { issueOperatorInvite } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { requireExomemOperator } from "@/lib/exomem-hosted/operator-auth";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type InviteBody = {
  email?: unknown;
  source?: unknown;
  marketplaceReviewerPurpose?: unknown;
  expiresAt?: unknown;
};

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    const preAuthAllowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.adminPreAuthMutationIp,
      clientAddressKey(request) ?? "unknown"
    );
    if (!preAuthAllowed) throw exomemErrors.rateLimited();
    const operator = requireExomemOperator(request);
    const allowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.adminAuthenticatedMutation,
      operator.principalDigest.toString("hex")
    );
    if (!allowed) throw exomemErrors.rateLimited();

    let body: InviteBody;
    try {
      body = (await request.json()) as InviteBody;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (
      typeof body.email !== "string" ||
      (body.source !== "complimentary" && body.source !== "paid") ||
      (body.marketplaceReviewerPurpose !== undefined &&
        typeof body.marketplaceReviewerPurpose !== "boolean")
    ) {
      throw exomemErrors.invalidRequest();
    }
    const expiresAt =
      typeof body.expiresAt === "string"
        ? new Date(body.expiresAt)
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const result = await issueOperatorInvite({
      email: body.email,
      source: body.source,
      marketplaceReviewerPurpose: body.marketplaceReviewerPurpose === true,
      expiresAt,
      operatorPrincipalDigest: operator.principalDigest,
    });
    emitAccessEvent({
      event: "access.invite.created",
      outcome: "succeeded",
      requestId,
    });
    return NextResponse.json(
      {
        success: true,
        status: "sent",
        inviteId: result.inviteId,
        requestId,
      },
      { status: 201 }
    );
  } catch (error) {
    return accessErrorResponse({
      error,
      event:
        error instanceof Error && "code" in error && error.code === "EMAIL_DELIVERY_UNAVAILABLE"
          ? "access.invite.delivery_failed"
          : "access.request.denied",
      requestId,
    });
  }
}
