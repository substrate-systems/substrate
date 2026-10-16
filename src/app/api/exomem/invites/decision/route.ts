import { NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { PRIVATE_NO_STORE_HEADERS } from "@/lib/exomem-hosted/http";
import { decideInvitation, type InvitationChoice } from "@/lib/exomem-hosted/invites";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "@/lib/exomem-hosted/rate-limit";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CHOICES: readonly InvitationChoice[] = ["use_friend_price", "keep_plan"];

/**
 * A signed-in owner's answer to an invitation for their own address: take
 * the friend price, or keep their plan. The body is exactly
 * `{token, choice}`; nothing else, a discount included, is accepted.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    if (session.reviewerCredentialId) throw exomemErrors.entitlementDenied();
    if (!(await takeExomemRateLimit(EXOMEM_RATE_LIMITS.ownerProviderCallTenant, session.tenantId)))
      throw exomemErrors.rateLimited();
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    const fields = body && typeof body === "object" && !Array.isArray(body) ? body : null;
    const token = (fields as Record<string, unknown> | null)?.token;
    const choice = (fields as Record<string, unknown> | null)?.choice;
    if (
      !fields ||
      Object.keys(fields).some((key) => key !== "token" && key !== "choice") ||
      typeof token !== "string" ||
      token.length === 0 ||
      !CHOICES.includes(choice as InvitationChoice)
    ) {
      throw exomemErrors.invalidRequest();
    }
    const decision = await decideInvitation({
      token,
      choice: choice as InvitationChoice,
      session: { id: session.id, userId: session.userId, tenantId: session.tenantId },
    });
    return NextResponse.json(decision, { status: 200, headers: PRIVATE_NO_STORE_HEADERS });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS))
      response.headers.set(name, value);
    return response;
  }
}
