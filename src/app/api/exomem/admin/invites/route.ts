import { NextRequest, NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { issueOperatorInvite, type ExomemInviteKind } from "@/lib/exomem-hosted/invites";
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
  kind?: unknown;
  inviterName?: unknown;
  inviterEmail?: unknown;
  inviteeName?: unknown;
  note?: unknown;
  marketplaceReviewerPurpose?: unknown;
  expiresAt?: unknown;
};

const KINDS: readonly ExomemInviteKind[] = ["standard", "friend", "covered"];
// An invitation lasts 30 days unless the operator sets an earlier end
// (design: a 30-day bearer credential, reminded 3 days before it ends).
const DEFAULT_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function optionalString(value: unknown): value is string | undefined | null {
  return value === undefined || value === null || typeof value === "string";
}

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
      !body ||
      typeof body !== "object" ||
      typeof body.email !== "string" ||
      !KINDS.includes(body.kind as ExomemInviteKind) ||
      !optionalString(body.inviterName) ||
      !optionalString(body.inviterEmail) ||
      !optionalString(body.inviteeName) ||
      !optionalString(body.note) ||
      (body.marketplaceReviewerPurpose !== undefined &&
        typeof body.marketplaceReviewerPurpose !== "boolean")
    ) {
      throw exomemErrors.invalidRequest();
    }
    const expiresAt =
      typeof body.expiresAt === "string"
        ? new Date(body.expiresAt)
        : new Date(Date.now() + DEFAULT_INVITE_TTL_MS);

    const result = await issueOperatorInvite({
      email: body.email,
      kind: body.kind as ExomemInviteKind,
      inviterName: body.inviterName,
      inviterEmail: body.inviterEmail,
      inviteeName: body.inviteeName,
      note: body.note,
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
        status: result.delivery,
        inviteId: result.inviteId,
        requestId,
      },
      { status: 201 }
    );
  } catch (error) {
    return accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
  }
}
