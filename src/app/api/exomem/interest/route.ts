import { NextRequest, NextResponse } from "next/server";
import { sendTransactionalEmail } from "@/lib/brevo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Exomem hosted-tier demand signal. This is a counter, not a signup: the landing
 * form POSTs an email (+ optional price tier) and we notify the founder inbox via
 * Brevo so interest can be tallied. No storage, no list subscription, no reply.
 *
 * Recipient defaults to the Brevo sender inbox; override with
 * EXOMEM_INTEREST_NOTIFY_TO.
 */

const TIER_LABELS: Record<string, string> = {
  none: "nothing — would self-host",
  "5": "~€5 / month",
  "10": "~€10 / month",
  "20": "€20+ / month",
};

// Deliberately lenient on address shape (we only count demand, never deliver
// here), but strict on characters: the value flows into both the email subject
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

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: "method_not_allowed" },
    { status: 405, headers: { allow: "POST" } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: "bad_request", message: "invalid JSON" },
      { status: 400 },
    );
  }

  const email = (body as { email?: unknown })?.email;
  const tierRaw = (body as { tier?: unknown })?.tier;

  if (typeof email !== "string" || !isValidEmail(email.trim())) {
    return NextResponse.json(
      { error: "bad_request", message: "a valid email is required" },
      { status: 400 },
    );
  }

  const cleanEmail = email.trim();
  const tier =
    typeof tierRaw === "string" && tierRaw in TIER_LABELS
      ? TIER_LABELS[tierRaw]
      : "not specified";

  // Default to the founder inbox (forwards to Gmail) so signals actually reach a
  // human without extra env config. Override with EXOMEM_INTEREST_NOTIFY_TO.
  const notifyTo =
    process.env.EXOMEM_INTEREST_NOTIFY_TO ?? "founder@substratesystems.io";

  try {
    const result = await sendTransactionalEmail({
      to: notifyTo,
      // Keep the verified from-address; brand the display name for Exomem.
      senderName: "Exomem",
      subject: `Exomem hosted interest — ${cleanEmail}`,
      htmlContent:
        `<p>New Exomem hosted-tier interest.</p>` +
        `<p><strong>Email:</strong> ${escapeHtml(cleanEmail)}<br>` +
        `<strong>Willingness to pay:</strong> ${escapeHtml(tier)}</p>`,
      textContent:
        `New Exomem hosted-tier interest.\n\n` +
        `Email: ${cleanEmail}\nWillingness to pay: ${tier}\n`,
    });

    if (!result.success) {
      // The visitor's UI confirms optimistically; log server-side for tallying.
      console.error("[exomem/interest] brevo send failed:", result.error);
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (err) {
    console.error("[exomem/interest] unexpected error:", err);
    // Still ack — this is a best-effort demand signal, not a transaction.
    return NextResponse.json({ ok: true }, { status: 200 });
  }
}
