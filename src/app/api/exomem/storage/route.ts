import { NextResponse } from "next/server";
import { handleCloudStorage } from "@/lib/exomem-hosted/cloud-storage";
import { storageRequest } from "@/lib/exomem/storage-contract";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { ExomemBillingError } from "@/lib/exomem-hosted/paddle-billing";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { resolveExomemSession, validateMutationRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const headers = {
    "cache-control": "private, no-store, max-age=0",
    "referrer-policy": "no-referrer",
  };
  try {
    if (process.env.EXOMEM_CLOUD_STORAGE_ENABLED !== "true")
      return new Response(null, { status: 404, headers });
    const session = await resolveExomemSession(request);
    validateMutationRequest(request, session);
    if (session.reviewerCredentialKind === "cloud_provider_review")
      throw exomemErrors.entitlementDenied();
    const input = storageRequest.safeParse(await readBoundedJsonRequest(request, 2048));
    if (!input.success) throw exomemErrors.invalidRequest();
    const result = await handleCloudStorage(session.userId, session.tenantId, input.data);
    return NextResponse.json({ success: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof ExomemBillingError)
      return NextResponse.json(
        {
          success: false,
          error: {
            code: error.code,
            message: "Paddle could not check this change just now.",
            retryable: true,
          },
        },
        { status: error.status, headers }
      );
    const response = safeErrorResponse(error);
    for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
    return response;
  }
}
