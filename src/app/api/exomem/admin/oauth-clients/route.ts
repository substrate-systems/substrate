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
  listOperatorOAuthClients,
  setOperatorOAuthClientEnabled,
} from "@/lib/exomem-hosted/operator-controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const clients = await listOperatorOAuthClients();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, clients, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    if (!UUID.test(String(body.id)) || typeof body.enabled !== "boolean") {
      throw exomemErrors.invalidRequest();
    }
    const updated = await setOperatorOAuthClientEnabled({
      clientRecordId: body.id as string,
      enabled: body.enabled,
    });
    if (!updated) throw exomemErrors.invalidRequest();
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, id: body.id, enabled: body.enabled, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
