import { NextRequest, NextResponse } from "next/server";
import { sendTransactionalEmail } from "@/lib/brevo";
import {
  clientAddressKey,
  EXOMEM_RATE_LIMITS,
  normalizedEmailRateLimitKey,
  takeExomemRateLimit,
} from "@/lib/exomem-hosted/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exomem friends-cohort invite request. The landing form POSTs an email and
 * optional preference; we notify the founder inbox via Brevo. This does not
 * promise an invite, and a delivery failure remains retryable to the visitor.
 *
 * Recipient defaults to the Brevo sender inbox; override with
 * EXOMEM_INTEREST_NOTIFY_TO.
 */

const TIER_LABELS: Record<string, string> = {
  complimentary: "complimentary private alpha",
  "5": "~€5 / month if paid access opens",
  "10": "~€10 / month if paid access opens",
  "20": "€20+ / month if paid access opens",
};

// Deliberately lenient on address shape, but strict on characters: the value
// flows into both the email subject
// and the HTML body, so this rejects whitespace/newlines (header + subject
// injection) and HTML metacharacters (`<>"'&` and backtick) outright.
const isValidEmail = (v: string) =>
  v.length <= 254 && /^[^\s<>"'`&]+@[^\s<>"'`&]+\.[^\s<>"'`&]+$/.test(v);

// Defense in depth: escape before interpolating into htmlContent, so tightening
// the validator later can't silently reintroduce an injection path.
const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

function retryableError(
  error: "rate_limited" | "service_unavailable",
  retryAfter: number
): NextResponse {
  return NextResponse.json(
    { error },
    {
      status: error === "rate_limited" ? 429 : 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": String(retryAfter),
      },
    }
  );
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { allow: "POST" } }
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "bad_request", message: "invalid JSON" }, { status: 400 });
  }

  const email = (body as { email?: unknown })?.email;
  const tierRaw = (body as { tier?: unknown })?.tier;

  if (typeof email !== "string" || !isValidEmail(email.trim())) {
    return NextResponse.json(
      { error: "bad_request", message: "a valid email is required" },
      { status: 400 }
    );
  }

  const cleanEmail = email.trim();
  try {
    const ipAllowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.interestIp,
      clientAddressKey(req) ?? "unavailable"
    );
    if (!ipAllowed)
      return retryableError("rate_limited", EXOMEM_RATE_LIMITS.interestIp.windowSeconds);
    const emailAllowed = await takeExomemRateLimit(
      EXOMEM_RATE_LIMITS.interestEmail,
      normalizedEmailRateLimitKey(cleanEmail)
    );
    if (!emailAllowed) {
      return retryableError("rate_limited", EXOMEM_RATE_LIMITS.interestEmail.windowSeconds);
    }
  } catch {
    return retryableError("service_unavailable", 60);
  }

  const tier =
    typeof tierRaw === "string" && tierRaw in TIER_LABELS ? TIER_LABELS[tierRaw] : "not specified";

  // Default to the founder inbox (forwards to Gmail) so signals actually reach a
  // human without extra env config. Override with EXOMEM_INTEREST_NOTIFY_TO.
  const notifyTo = process.env.EXOMEM_INTEREST_NOTIFY_TO ?? "founder@substratesystems.io";

  try {
    const result = await sendTransactionalEmail({
      to: notifyTo,
      // Keep the verified from-address; brand the display name for Exomem.
      senderName: "Exomem",
      subject: `Exomem friends-cohort invite request — ${cleanEmail}`,
      htmlContent:
        `<p>New Exomem friends-cohort invite request.</p>` +
        `<p><strong>Email:</strong> ${escapeHtml(cleanEmail)}<br>` +
        `<strong>Cohort preference:</strong> ${escapeHtml(tier)}</p>`,
      textContent:
        `New Exomem friends-cohort invite request.\n\n` +
        `Email: ${cleanEmail}\nCohort preference: ${tier}\n`,
    });

    if (!result.success) {
      console.error("[exomem/interest] delivery unavailable");
      return retryableError("service_unavailable", 60);
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    console.error("[exomem/interest] delivery exception");
    return retryableError("service_unavailable", 60);
  }
}
