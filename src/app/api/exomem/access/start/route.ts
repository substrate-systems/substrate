import { NextRequest, NextResponse } from "next/server";
import { exomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { uniformAccessStartResponse } from "@/lib/exomem-hosted/access-recovery";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import {
  accessErrorResponse,
  emitAccessEvent,
  newRequestId,
  readBoundedJsonRequest,
} from "@/lib/exomem-hosted/http";
import { clientAddressKey } from "@/lib/exomem-hosted/rate-limit";
import { validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";
import { normalizeTimeZone } from "@/lib/exomem-hosted/time-zone";
import { verifyTurnstileToken } from "@/lib/exomem-hosted/turnstile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Room for an email address, a Turnstile token (at most 2048 characters), a
// time zone name and an email scheme.
const MAX_BODY_BYTES = 8 * 1024;
const BODY_KEYS = new Set(["email", "turnstileToken", "timeZone", "emailScheme"]);
const NO_STORE = { "cache-control": "no-store" } as const;

/**
 * POST /api/exomem/access/start — "Start with your email", for new and
 * returning people. Body: `{email, turnstileToken, timeZone?, emailScheme?}`.
 * An `emailScheme` other than "dark" or "light" is unknown, not an error.
 *
 * - A missing, invalid or reused Turnstile token: 400 `challenge_failed`.
 *   That answer depends on the token only, never on the email.
 * - Every other case: the same 202, the same body and the same challenge
 *   cookie, padded to one time floor. The email carries the outcome.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = newRequestId();
  try {
    validatePublicAccessRequest(request);
    const body = await readBoundedJsonRequest(request, MAX_BODY_BYTES);
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !BODY_KEYS.has(key))
    ) {
      throw exomemErrors.invalidRequest();
    }
    const fields = body as Record<string, unknown>;
    if (typeof fields.email !== "string") throw exomemErrors.invalidRequest();
    if (
      fields.timeZone !== undefined &&
      fields.timeZone !== null &&
      typeof fields.timeZone !== "string"
    ) {
      throw exomemErrors.invalidRequest();
    }

    const networkKey = clientAddressKey(request);
    const verdict = await verifyTurnstileToken({
      token: fields.turnstileToken,
      remoteIp: networkKey,
    });
    if (verdict === "failed") {
      emitAccessEvent({ event: "access.start.challenge_failed", outcome: "denied", requestId });
      return NextResponse.json(
        { success: false, error: "challenge_failed" },
        { status: 400, headers: NO_STORE }
      );
    }
    if (verdict === "unavailable") {
      emitAccessEvent({
        event: "access.start.challenge_unavailable",
        outcome: "failed",
        requestId,
      });
    }

    const response = await uniformAccessStartResponse(request, {
      email: fields.email,
      timeZone: normalizeTimeZone(fields.timeZone),
      emailScheme: exomemEmailScheme(fields.emailScheme),
      requestId,
      resend: false,
    });
    emitAccessEvent({ event: "access.start.accepted", outcome: "succeeded", requestId });
    return response;
  } catch (error) {
    const response = accessErrorResponse({ error, event: "access.request.denied", requestId });
    response.headers.set("cache-control", "no-store");
    return response;
  }
}
