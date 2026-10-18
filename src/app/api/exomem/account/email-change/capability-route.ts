import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { completeExomemEmailChange } from "@/lib/exomem-hosted/email-change";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";

const Capability = z.object({ token: z.string().max(128) }).strict();
const headers = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
};

export async function completeEmailChangeRequest(
  request: NextRequest,
  action: "confirm" | "cancel"
): Promise<NextResponse> {
  try {
    validatePublicAccessRequest(request);
    const input = Capability.safeParse(await readBoundedJsonRequest(request, 256));
    if (!input.success) throw exomemErrors.invalidRequest();
    return NextResponse.json(
      { success: true, ...(await completeExomemEmailChange(action, input.data.token)) },
      { headers }
    );
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}
