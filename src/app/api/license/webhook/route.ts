import { NextRequest, NextResponse } from "next/server";
import {
  PaddleSignatureError,
  extractTransactionFields,
  fetchPaddleCustomerEmail,
  verifyPaddleSignature,
} from "@/lib/license/paddle";
import { configuredSupportTiers } from "@/lib/support-tiers";
import { recordSupporterContribution } from "@/lib/hosted-backup/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Paddle still targets this compatibility URL. The handler itself is for the
// recognition-only "Support Endstate" contribution; the retired licence model is
// not reintroduced by keeping an externally configured route stable.

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

  // Every configured "Support Endstate" contribution amount, including the
  // original €89 price, whose env var name is deliberately unchanged so
  // existing support records stay valid (see docs/naming.md). Newer amounts are
  // additive: a price that is not yet configured simply is not in this list.
  const supportPriceIds = configuredSupportTiers()
    .map((tier) => tier.priceId)
    .filter((id): id is string => Boolean(id));

  if (supportPriceIds.length === 0) {
    return NextResponse.json(
      {
        error: "server_misconfigured",
        message: "no Endstate support price IDs are configured",
      },
      { status: 500 }
    );
  }

  // Support contribution: recognition only — no entitlement key. Thank the
  // contributor (and invite opt-in public listing) + notify founder@ so the name
  // can be added to SUPPORTERS.md. Reuses the existing Brevo infra; no key is
  // issued and no entitlement is created.
  const tier = configuredSupportTiers().find(
    (candidate) => candidate.priceId && eventPriceIds.includes(candidate.priceId)
  );
  if (tier) {
    return handleSupporterPurchase(event, tier.id);
  }

  // No other one-time SKU is handled (the lifetime product was retired).
  return NextResponse.json(
    { ignored: true, reason: "no handler for transaction" },
    { status: 200 }
  );
}

// Supporter tier handler (recognition only, no entitlement key). The durable
// contribution and its email obligations are inserted before acknowledgment;
// the cron worker does the actual recognition mail delivery.
async function handleSupporterPurchase(event: unknown, tier: string): Promise<NextResponse> {
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

  const eventId = (event as { event_id?: unknown }).event_id;
  if (typeof eventId !== "string" || eventId.length === 0 || transactionId === "unknown") {
    return NextResponse.json(
      { error: "bad_request", message: "missing Paddle event or transaction identity" },
      { status: 400 }
    );
  }
  const inserted = await recordSupporterContribution({ transactionId, eventId, tier, email });
  if (!inserted)
    return NextResponse.json({ ok: true, supporter: true, replay: true }, { status: 200 });
  // The webhook persists the contribution and both email obligations before
  // acknowledging. The authenticated cron drains the outbox with retries;
  // delivery uncertainty never loses a contribution or duplicates it.
  return NextResponse.json({ ok: true, supporter: true, queued: true }, { status: 200 });
}
