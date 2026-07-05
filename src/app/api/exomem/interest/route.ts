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

const isValidEmail = (v: string) =>
  v.indexOf("@") >= 1 && v.indexOf(".") > v.indexOf("@") && v.length <= 254;

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

  const notifyTo =
    process.env.EXOMEM_INTEREST_NOTIFY_TO ??
    process.env.BREVO_SENDER_EMAIL ??
    "licenses@substratesystems.io";

  try {
    const result = await sendTransactionalEmail({
      to: notifyTo,
      subject: `Exomem hosted interest — ${cleanEmail}`,
      htmlContent:
        `<p>New Exomem hosted-tier interest.</p>` +
        `<p><strong>Email:</strong> ${cleanEmail}<br>` +
        `<strong>Willingness to pay:</strong> ${tier}</p>`,
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
