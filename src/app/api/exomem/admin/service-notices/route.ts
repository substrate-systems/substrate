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
  cancelServiceNotice,
  createServiceNotice,
  describeNotice,
  listServiceNotices,
  parseNewNotice,
  previewServiceNotice,
  resolveServiceNotice,
} from "@/lib/exomem-hosted/service-notices";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Current notices first, then the newest others. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request, "read");
    const at = new Date();
    const notices = (await listServiceNotices()).map((notice) => describeNotice(notice, at));
    operatorSuccessEvent(requestId);
    return NextResponse.json({ success: true, notices, requestId });
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}

/** `action`: `preview` and `create` take the notice fields; `cancel` and `resolve` take `id`. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    await requireRateLimitedExomemOperator(request);
    const body = await readOperatorJsonRecord(request);
    const at = new Date();
    if (body.action === "preview") {
      const preview = await previewServiceNotice(parseNewNotice(body, at));
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, preview, requestId });
    }
    if (body.action === "create") {
      const notice = await createServiceNotice(parseNewNotice(body, at));
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, notice: describeNotice(notice, at), requestId });
    }
    if (body.action === "cancel" || body.action === "resolve") {
      if (typeof body.id !== "string" || !UUID.test(body.id)) throw exomemErrors.invalidRequest();
      const notice =
        body.action === "cancel"
          ? await cancelServiceNotice(body.id)
          : await resolveServiceNotice(body.id);
      operatorSuccessEvent(requestId);
      return NextResponse.json({ success: true, notice: describeNotice(notice, at), requestId });
    }
    throw exomemErrors.invalidRequest();
  } catch (error) {
    return operatorErrorResponse(error, requestId);
  }
}
