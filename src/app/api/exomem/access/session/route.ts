import { NextRequest, NextResponse } from "next/server";
import { normalizeAccessEmail } from "@/lib/exomem-hosted/access";
import { executeExomemSql } from "@/lib/exomem-hosted/db";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/http";
import {
  oauthConsentPath,
  oauthContinuationToken,
  resolveOAuthContinuation,
  validateOAuthContinuationNonce,
} from "@/lib/exomem-hosted/oauth-continuity";
import { resolveExomemSession, validatePublicAccessRequest } from "@/lib/exomem-hosted/sessions";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow" };

/** A tab notification prompts this authoritative read; it never supplies identity or a destination. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    validatePublicAccessRequest(request);
    const input = await readBoundedJsonRequest(request, 1024);
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof (input as Record<string, unknown>).expectedEmail !== "string"
    ) {
      throw exomemErrors.invalidRequest();
    }
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).some((key) => key !== "expectedEmail" && key !== "formNonce") ||
      (body.formNonce !== undefined && typeof body.formNonce !== "string")
    ) {
      throw exomemErrors.invalidRequest();
    }
    const session = await resolveExomemSession(request);
    const { rows } = await executeExomemSql`
      SELECT email::text AS email FROM exomem_users
      WHERE id = ${session.userId} AND deleted_at IS NULL
    `;
    const accountEmail = rows[0]?.email;
    if (
      typeof accountEmail !== "string" ||
      normalizeAccessEmail(accountEmail) !== normalizeAccessEmail(body.expectedEmail as string)
    ) {
      return NextResponse.json({ authenticated: false }, { headers: NO_STORE });
    }
    let destination: string | null = "/exomem/home";
    if (typeof body.formNonce === "string") {
      const transaction = oauthContinuationToken(request);
      const continuation = transaction ? await resolveOAuthContinuation(request) : null;
      // A different tab may replace the browser's app request; retain the original nonce binding.
      destination =
        transaction &&
        continuation &&
        validateOAuthContinuationNonce({ continuation, transaction, formNonce: body.formNonce })
          ? oauthConsentPath(transaction)
          : null;
    }
    return NextResponse.json({ authenticated: true, destination }, { headers: NO_STORE });
  } catch (error) {
    const response = safeErrorResponse(error);
    for (const [key, value] of Object.entries(NO_STORE)) response.headers.set(key, value);
    return response;
  }
}
