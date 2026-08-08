import { NextRequest, NextResponse } from "next/server";
import { requestSelfServeAccess } from "@/lib/exomem-hosted/access";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, emitAccessEvent, newRequestId } from "@/lib/exomem-hosted/http";
import { clientAddressKey } from "@/lib/exomem-hosted/rate-limit";
import { validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Self-serve admission. Unlike the magic-link route this answers plainly, because
 * the answer is about pool capacity rather than about whether an account exists —
 * it is identical for every visitor, so it discloses nothing. Telling the truth
 * here is the whole point: a waitlisted visitor must learn it now, not after a
 * charge.
 */
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
    const result = await requestSelfServeAccess({
      email: body.email,
      networkKey: clientAddressKey(request) ?? "unavailable",
    });
    // By this point the decision is committed: an admitted visitor has an invite
    // minted and a setup link already sent. Telemetry must not be able to turn
    // that into a failure the caller sees, or they are told to try again while
    // holding a live link — and a retry supersedes the invite they were sent.
    try {
      emitAccessEvent({
        event:
          result.outcome === "admitted"
            ? "access.self_serve.admitted"
            : "access.self_serve.waitlisted",
        outcome: "succeeded",
        requestId,
      });
    } catch {
      // Intentionally swallowed; the observability channel is not the operation.
    }
    return NextResponse.json(
      {
        success: true,
        status: result.outcome,
        ...(result.position === undefined ? {} : { position: result.position }),
        requestId,
      },
      { status: 202, headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    return accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
  }
}
