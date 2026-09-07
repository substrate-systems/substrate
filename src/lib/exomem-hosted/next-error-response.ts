import { NextResponse } from "next/server";
import { ExomemHostedError, safeErrorEnvelope, type ExomemHostedErrorEnvelope } from "./errors";

/** Next adapter for web routes that need the cookie-aware response extension. */
export function safeErrorResponse(
  error: unknown,
  requestId?: string
): NextResponse<ExomemHostedErrorEnvelope> {
  const status = error instanceof ExomemHostedError ? error.status : 500;
  return NextResponse.json(safeErrorEnvelope(error, requestId), { status });
}
