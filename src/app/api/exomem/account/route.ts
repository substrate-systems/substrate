import { NextRequest, NextResponse } from "next/server";
import { ownerBillingSummary } from "@/lib/exomem-hosted/billing-account";
import { loadOwnerInstallActions } from "@/lib/exomem-hosted/account-install-actions";
import { safeErrorResponse } from "@/lib/exomem-hosted/errors";
import { resolveExomemSession } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    return NextResponse.json(
      {
        success: true,
        billing: await ownerBillingSummary(session.userId, session.tenantId),
        installActions: await loadOwnerInstallActions(session.userId, session.tenantId),
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
