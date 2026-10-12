import { isIP } from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { accessErrorResponse, newRequestId } from "@/lib/exomem-hosted/http";
import { inspectInvitation } from "@/lib/exomem-hosted/invites";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";
import { resolveExomemSession, validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store, private" };

// The platform's geolocation of the caller (ISO 3166 alpha-2), set by the
// hosting edge. It only keys the price cache; Paddle prices the caller's IP.
const COUNTRY_HEADER = "x-vercel-ip-country";
const COUNTRY_CODE = /^[A-Z]{2}$/;

async function signedInUserId(request: NextRequest): Promise<string | null> {
  try {
    return (await resolveExomemSession(request)).userId;
  } catch {
    return null;
  }
}

/**
 * The invitation behind a bearer token. Every unusable token (unknown,
 * expired, used, revoked) gets the same 404 body and headers. A token never
 * signs anybody in: this route sets no cookie.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    const address = clientAddressKey(request);
    if (!(await takeExomemRateLimit(EXOMEM_RATE_LIMITS.inviteInspectIp, address ?? "unknown"))) {
      throw exomemErrors.rateLimited();
    }
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      throw exomemErrors.invalidRequest();
    }
    if (
      !body ||
      typeof body !== "object" ||
      typeof body.token !== "string" ||
      body.token.length === 0 ||
      Object.keys(body).some((key) => key !== "token")
    ) {
      throw exomemErrors.invalidRequest();
    }
    const country = request.headers.get(COUNTRY_HEADER)?.trim().toUpperCase() ?? "";
    const inspection = await inspectInvitation({
      token: body.token,
      country: COUNTRY_CODE.test(country) ? country : null,
      customerIp: address && isIP(address) ? address : null,
      sessionUserId: await signedInUserId(request),
    });
    if (!inspection) {
      return NextResponse.json({ status: "unusable" }, { status: 404, headers: NO_STORE });
    }
    return NextResponse.json(inspection, { status: 200, headers: NO_STORE });
  } catch (error) {
    const response = accessErrorResponse({
      error,
      event: "access.request.denied",
      requestId,
    });
    response.headers.set("cache-control", NO_STORE["cache-control"]);
    return response;
  }
}
