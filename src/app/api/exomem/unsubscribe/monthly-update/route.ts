import { NextRequest, NextResponse } from "next/server";
import { exomemErrors } from "@/lib/exomem-hosted/errors";
import { safeErrorResponse } from "@/lib/exomem-hosted/next-error-response";
import { unsubscribeMonthlyUpdateEmail } from "@/lib/exomem-hosted/whats-new-digest/setting";
import {
  UnsubscribeKeyError,
  unsubscribeKey,
  verifyUnsubscribeToken,
} from "@/lib/exomem-hosted/whats-new-digest/unsubscribe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const headers = {
  "cache-control": "private, no-store, max-age=0",
  "x-robots-tag": "noindex, nofollow",
  "referrer-policy": "no-referrer",
};

/**
 * The monthly digest's one-click unsubscribe (`send-monthly-whats-new-digest`,
 * D5, RFC 8058): a mail client POSTs to the address in `List-Unsubscribe`, and the
 * page's button sends the same POST. The signed token in the query names the
 * tenant. Only this POST changes the setting; a GET is not exported, so Next
 * answers 405 and a link scanner changes nothing.
 *
 * No rate limit: the MAC is checked before anything reads the database, and a
 * valid token only repeats an idempotent write. A limit per address would
 * refuse the mail providers that post for many owners from a few addresses.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const token = request.nextUrl.searchParams.get("token");
    const tenantId = token ? verifyUnsubscribeToken(token, unsubscribeKey()) : null;
    if (!tenantId) throw exomemErrors.accessTokenInvalid();
    await unsubscribeMonthlyUpdateEmail(tenantId);
    return NextResponse.json({ success: true }, { headers });
  } catch (error) {
    // A missing key is the deployment's fault, so say "try again" rather than "invalid link".
    const response =
      error instanceof UnsubscribeKeyError
        ? NextResponse.json(
            { success: false, error: { code: "UNSUBSCRIBE_UNAVAILABLE", retryable: true } },
            { status: 503 }
          )
        : safeErrorResponse(error);
    for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
    return response;
  }
}
