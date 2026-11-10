import { NextResponse } from "next/server";
import {
  alertEndpointNotFound,
  ExomemHostedError,
  safeErrorEnvelope,
  type ExomemHostedErrorEnvelope,
} from "./errors";

/** Next adapter for web routes that need the cookie-aware response extension. */
export function safeErrorResponse(
  error: unknown,
  requestId?: string
): NextResponse<ExomemHostedErrorEnvelope> {
  const status = error instanceof ExomemHostedError ? error.status : 500;
  return NextResponse.json(safeErrorEnvelope(error, requestId), { status });
}

/** The shared 404 body for every capability-authenticated endpoint, so a wrong
 * method or a refused capability is indistinguishable across routes. The code
 * comes from the receiver's own not-found error: one place for the string. */
export function capabilityEndpointNotFoundResponse(): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: alertEndpointNotFound().code, retryable: false } },
    { status: 404, headers: { "cache-control": "no-store" } }
  );
}
