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
  revokeOperatorOAuthAccount,
  revokeOperatorOAuthFamily,
} from "@/lib/exomem-hosted/operator-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const id = (value: unknown): string | null =>
  typeof value === "string" && UUID.test(value) ? value : null;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const ownerUserId = id(body.ownerUserId);
    const tenantId = id(body.tenantId);
    if (!ownerUserId || !tenantId) throw exomemErrors.invalidRequest();
    if (body.action === "family") {
      const familyId = id(body.familyId);
      if (!familyId) throw exomemErrors.invalidRequest();
      const revoked = await revokeOperatorOAuthFamily({ ownerUserId, tenantId, familyId });
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, revoked, requestId });
    }
    if (body.action === "account") {
      const revokedFamilies = await revokeOperatorOAuthAccount({ ownerUserId, tenantId });
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, revokedFamilies, requestId });
    }
    throw exomemErrors.invalidRequest();
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
