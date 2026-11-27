import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";
import {
  dismissMonthlyUpdateInvitation,
  setMonthlyUpdateEmail,
} from "@/lib/exomem-hosted/whats-new-digest/setting";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One change at a time: the setting, or the dismissal of Home's invitation.
const Change = z.union([
  z.object({ enabled: z.boolean() }).strict(),
  z.object({ dismissInvitation: z.literal(true) }).strict(),
]);
const headers = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
};

/**
 * Home's "Monthly update email" setting (`send-monthly-whats-new-digest`, D5):
 * the owner turns it on or off, or dismisses the invitation to it. A reviewer
 * account has no such setting and gets a refusal.
 */
export async function PUT(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const change = Change.safeParse(await readBoundedJsonRequest(request, 256));
    if (!change.success) throw exomemErrors.invalidRequest();
    const principal = { userId: session.userId, tenantId: session.tenantId };
    const saved =
      "enabled" in change.data
        ? await setMonthlyUpdateEmail(principal, change.data.enabled)
        : await dismissMonthlyUpdateInvitation(principal);
    if (!saved) throw exomemErrors.entitlementDenied();
    return NextResponse.json({ success: true, monthlyUpdateEmail: saved }, { headers });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}
