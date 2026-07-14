import { NextRequest, NextResponse } from "next/server";
import { requestMagicLink } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { clientAddressKey } from "@/lib/exomem-hosted/rate-limit";
import {
  applyMagicLinkChallengeCookie,
  mintMagicLinkChallenge,
  validatePublicAccessRequest,
} from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GENERIC_RESPONSE = {
  success: true,
  status: "if_eligible_email_sent",
} as const;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (typeof body.email !== "string" || Object.keys(body).length !== 1) {
      throw exomemErrors.invalidRequest();
    }
    const challenge = mintMagicLinkChallenge();
    await requestMagicLink({
      email: body.email,
      networkKey: clientAddressKey(request) ?? "unavailable",
      browserChallengeDigest: challenge.challengeDigest,
    });
    emitAccessEvent({
      event: "access.magic_link.requested",
      outcome: "succeeded",
      requestId,
    });
    const response = NextResponse.json({ ...GENERIC_RESPONSE, requestId }, { status: 202 });
    applyMagicLinkChallengeCookie(response, challenge);
    return response;
  } catch (error) {
    return accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
  }
}
