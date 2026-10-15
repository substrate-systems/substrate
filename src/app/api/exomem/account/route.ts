import { NextRequest, NextResponse } from "next/server";
import { loadExomemAccountView } from "@/lib/exomem-hosted/account-view";
import { ownerBillingSummary } from "@/lib/exomem-hosted/billing-account";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    const tenantId = new URL(request.url).searchParams.get("tenantId");
    // The rendered checkout ID checks consistency; this session authorizes all returned facts.
    if (tenantId !== null && tenantId !== session.tenantId) throw exomemErrors.entitlementDenied();
    return NextResponse.json(
      {
        success: true,
        billing: await ownerBillingSummary(session.userId, session.tenantId),
        account: await loadExomemAccountView(session),
      },
      {
        headers: {
          "cache-control": "private, no-store, max-age=0",
          "x-robots-tag": "noindex, nofollow",
        },
      }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    response.headers.set("cache-control", "private, no-store, max-age=0");
    response.headers.set("x-robots-tag", "noindex, nofollow");
    return response;
  }
}
