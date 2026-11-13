import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readBoundedJsonRequest } from "@/lib/exomem-hosted/bounded-json";
import { ExomemHostedError } from "@/lib/exomem-hosted/errors";
import {
  parseProviderEvents,
  storeProviderEvents,
} from "@/lib/exomem-hosted/email-provider-events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A batch of events is a few hundred bytes each; this bound is far above any real delivery.
const MAX_BODY_BYTES = 256 * 1024;
const NO_STORE = { "cache-control": "no-store" } as const;

/** Compares digests, so a wrong token of any length takes the same time. */
function tokenMatches(provided: string, expected: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value, "utf8").digest();
  return timingSafeEqual(digest(provided), digest(expected));
}

function answer(status: number, body: Record<string, unknown>): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/**
 * POST /api/webhooks/brevo — Brevo's transactional email events, which record
 * what became of an email after Brevo accepted it (delivered, deferred,
 * bounced). Brevo sends `Authorization: Bearer <BREVO_WEBHOOK_TOKEN>`.
 *
 * - No token configured: 503, and nothing is stored. A wrong or missing token: 401.
 * - Stored, already stored and ignored events (opens, clicks, unknown names)
 *   all answer 200, because Brevo retries anything else.
 * - A body that is not JSON, or is too large: 4xx, which Brevo discards.
 * - Our own failure to store: 5xx, which Brevo retries after 10 minutes, 1 hour,
 *   2 hours and 8 hours.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const expected = process.env.BREVO_WEBHOOK_TOKEN?.trim();
  if (!expected) {
    console.error("[brevo webhook] BREVO_WEBHOOK_TOKEN is not set");
    return answer(503, { success: false, error: "not_configured" });
  }
  const header = request.headers.get("authorization");
  const provided = header?.toLowerCase().startsWith("bearer ")
    ? header.slice("bearer ".length).trim()
    : "";
  if (!provided || !tokenMatches(provided, expected)) {
    return answer(401, { success: false, error: "unauthorized" });
  }

  let body: unknown;
  try {
    body = await readBoundedJsonRequest(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof ExomemHostedError && error.status === 413) {
      return answer(413, { success: false, error: "too_large" });
    }
    return answer(400, { success: false, error: "invalid_json" });
  }
  const parsed = parseProviderEvents(body);
  if (!parsed) return answer(400, { success: false, error: "invalid_event" });

  try {
    const stored = await storeProviderEvents(parsed.events);
    return answer(200, {
      success: true,
      stored,
      duplicates: parsed.events.length - stored,
      ignored: parsed.ignored,
    });
  } catch {
    console.error("[brevo webhook] storing provider events failed");
    return answer(500, { success: false, error: "store_unavailable" });
  }
}
