import { NextRequest, NextResponse } from "next/server";
import { sendTransactionalEmail } from "@/lib/brevo";
import { captureServer, ServerEvent } from "@/lib/analytics-server";
import {
  PaddleSignatureError,
  extractTransactionFields,
  fetchPaddleCustomerEmail,
  verifyPaddleSignature,
} from "@/lib/license/paddle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "server_misconfigured", message: "PADDLE_WEBHOOK_SECRET is not set" },
      { status: 500 }
    );
  }

  const rawBody = await req.text();

  try {
    verifyPaddleSignature({
      header: req.headers.get("paddle-signature"),
      rawBody,
      secret,
    });
  } catch (err) {
    if (err instanceof PaddleSignatureError) {
      return NextResponse.json(
        { error: "invalid_signature", message: err.message },
        { status: 401 }
      );
    }
    throw err;
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "bad_request", message: "invalid JSON" }, { status: 400 });
  }

  const eventType = (event as { event_type?: string })?.event_type;
  if (eventType !== "transaction.completed") {
    return NextResponse.json({ ignored: true, event_type: eventType }, { status: 200 });
  }

  // Determine which one-time SKU this purchase is for.
  const eventItems =
    (event as { data?: { items?: Array<{ price?: { id?: string } }> } })?.data?.items ?? [];
  const eventPriceIds = eventItems
    .map((item) => item?.price?.id)
    .filter((id): id is string => Boolean(id));

  const supporterPriceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
  if (!supporterPriceId) {
    return NextResponse.json(
      {
        error: "server_misconfigured",
        message: "NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER is not set",
      },
      { status: 500 }
    );
  }

  // Supporter tier: recognition only — NO license key. Thank the buyer (and
  // invite opt-in public listing) + notify founder@ so the name can be added to
  // SUPPORTERS.md. Reuses the existing Brevo infra; no license key is issued.
  if (eventPriceIds.includes(supporterPriceId)) {
    return handleSupporterPurchase(event);
  }

  // No other one-time SKU is handled (the lifetime license SKU was retired).
  return NextResponse.json(
    { ignored: true, reason: "no handler for transaction" },
    { status: 200 }
  );
}

// Supporter tier handler (recognition only, NO license key). Thanks the buyer,
// invites opt-in public listing, and notifies founder@ to update SUPPORTERS.md.
// v1: no persistent idempotency (low-volume goodwill tier) — always returns 200
// so Paddle does not retry; a rare double-delivery could send a duplicate email.
// Add dedup when the supporters DB table lands.
async function handleSupporterPurchase(event: unknown): Promise<NextResponse> {
  // HTML-escape any value interpolated into an HTML email body. email/transactionId
  // are Paddle-derived (semi-trusted); escaping prevents HTML/script injection into
  // the founder notification rendered in an inbox.
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");

  let transactionId = "unknown";
  let email: string | null = null;
  let customerId: string | null = null;
  try {
    ({ transactionId, email, customerId } = extractTransactionFields(event));
  } catch (err) {
    console.warn(
      "[supporter webhook] extractTransactionFields failed:",
      err instanceof Error ? err.message : err
    );
  }
  if (!email && customerId) {
    try {
      email = await fetchPaddleCustomerEmail(customerId);
    } catch {
      /* best effort — still notify founder below */
    }
  }

  await sendTransactionalEmail({
    to: "founder@substratesystems.io",
    subject: `New Endstate supporter: ${email ?? "unknown email"}`,
    htmlContent: `<p>New Supporter License purchase.</p><p>Email: ${esc(email ?? "unknown")}<br/>Transaction: ${esc(transactionId)}</p><p>If they reply opting in, add their name to SUPPORTERS.md.</p>`,
    textContent: `New Supporter License purchase.\nEmail: ${email ?? "unknown"}\nTransaction: ${transactionId}\nIf they reply opting in, add their name to SUPPORTERS.md.`,
  }).catch((err) => console.error("[supporter webhook] founder notification failed:", err));

  if (email) {
    await sendTransactionalEmail({
      to: email,
      subject: "Thank you for supporting Endstate",
      htmlContent: `<p>Thank you for becoming an Endstate supporter. This directly funds development and keeps Endstate free for everyone — that's the whole pitch.</p><p>If you'd like your name listed publicly (supporters page + GitHub repo), just reply with the name you'd like shown. Prefer to stay anonymous? Nothing to do.</p><p>— Hugo</p>`,
      textContent: `Thank you for becoming an Endstate supporter. This directly funds development and keeps Endstate free for everyone — that's the whole pitch.\n\nIf you'd like your name listed publicly (supporters page + GitHub repo), just reply with the name you'd like shown. Prefer to stay anonymous? Nothing to do.\n\n— Hugo`,
    }).catch((err) => console.error("[supporter webhook] thank-you email failed:", err));
  }

  // Captured before acknowledgement, after the notifications that carry the
  // actual obligation. Deliberately carries no email and no transaction id: a
  // supporter purchase is a revenue count here, and the buyer's identity already
  // lives in Paddle and in the founder notification. captureServer swallows its
  // own failures, so this cannot cost the 200 and trigger a redelivery.
  await captureServer({
    event: ServerEvent.LicensePurchased,
    distinctId: null,
    properties: { product: "supporter" },
  });

  return NextResponse.json({ ok: true, supporter: true }, { status: 200 });
}
