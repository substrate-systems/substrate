import { NextResponse } from "next/server";
import { z } from "zod";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { PRIVATE_NO_STORE_HEADERS, readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { setOwnerAppContext } from "@/lib/exomem-hosted/owner-apps";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ContextRequest = z
  .object({
    context: z.enum(["coding", "conversation"]),
  })
  .strict();

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    const { id } = await context.params;
    const body = ContextRequest.safeParse(await readBoundedJsonRequest(request, 256));
    if (!body.success) throw exomemErrors.invalidRequest();
    // Another account's app and an id that never existed answer the same 404.
    const updated = await setOwnerAppContext({
      userId: session.userId,
      tenantId: session.tenantId,
      appId: id,
      context: body.data.context,
    });
    return NextResponse.json(updated ? { status: "updated" } : { status: "not_found" }, {
      status: updated ? 200 : 404,
      headers: PRIVATE_NO_STORE_HEADERS,
    });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(PRIVATE_NO_STORE_HEADERS))
      response.headers.set(name, value);
    return response;
  }
}
