import { NextRequest, NextResponse } from 'next/server';
import { sendTransactionalEmail } from '@/lib/brevo';
import { renderLicenseKeyEmail } from '@/lib/email-templates/license-key';
import { createLicenseKey } from '@/lib/license/crypto';
import {
  findLicenseByTransactionId,
  insertLicense,
} from '@/lib/license/db';
import {
  PaddleSignatureError,
  extractTransactionFields,
  fetchPaddleCustomerEmail,
  verifyPaddleSignature,
} from '@/lib/license/paddle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'server_misconfigured', message: 'PADDLE_WEBHOOK_SECRET is not set' },
      { status: 500 },
    );
  }

  const rawBody = await req.text();

  try {
    verifyPaddleSignature({
      header: req.headers.get('paddle-signature'),
      rawBody,
      secret,
    });
  } catch (err) {
    if (err instanceof PaddleSignatureError) {
      return NextResponse.json(
        { error: 'invalid_signature', message: err.message },
        { status: 401 },
      );
    }
    throw err;
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: 'bad_request', message: 'invalid JSON' },
      { status: 400 },
    );
  }

  const eventType = (event as { event_type?: string })?.event_type;
  if (eventType !== 'transaction.completed') {
    return NextResponse.json({ ignored: true, event_type: eventType }, { status: 200 });
  }

  // Determine which one-time SKU this purchase is for.
  const eventItems =
    (event as { data?: { items?: Array<{ price?: { id?: string } }> } })?.data
      ?.items ?? [];
  const eventPriceIds = eventItems
    .map((item) => item?.price?.id)
    .filter((id): id is string => Boolean(id));

  const supporterPriceId =
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
  const lifetimePriceId =
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_LIFETIME;

  // Supporter tier: recognition only — NO license key. Thank the buyer (and
  // invite opt-in public listing) + notify founder@ so the name can be added to
  // SUPPORTERS.md. Reuses the existing Brevo infra; no license key is issued.
  if (supporterPriceId && eventPriceIds.includes(supporterPriceId)) {
    return handleSupporterPurchase(event);
  }

  // Price gate (defensive): ONLY the legacy lifetime SKU may mint a license key.
  // Any other one-time purchase is ignored, so it can never receive a key.
  if (!lifetimePriceId || !eventPriceIds.includes(lifetimePriceId)) {
    return NextResponse.json(
      { ignored: true, reason: 'not a lifetime-license transaction' },
      { status: 200 },
    );
  }

  let transactionId: string;
  let email: string | null;
  let customerId: string | null;
  try {
    ({ transactionId, email, customerId } = extractTransactionFields(event));
  } catch (err) {
    return NextResponse.json(
      {
        error: 'bad_request',
        message: err instanceof Error ? err.message : 'invalid event',
      },
      { status: 400 },
    );
  }

  // Idempotency: Paddle retries webhooks on any non-2xx. A duplicate delivery
  // must not create a second license row or send a second email.
  const existing = await findLicenseByTransactionId(transactionId);
  if (existing) {
    return NextResponse.json({ ok: true, deduped: true }, { status: 200 });
  }

  if (!email && customerId) {
    try {
      email = await fetchPaddleCustomerEmail(customerId);
    } catch (err) {
      console.warn(
        `[license webhook] failed to fetch customer ${customerId}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Simulation/test fallback: no real email resolvable. Store a placeholder
  // so the license still lands in the DB, and skip the email send.
  const emailMissing = !email;
  if (emailMissing) {
    console.warn(
      `[license webhook] no email resolved for transaction ${transactionId}; storing placeholder and skipping email send`,
    );
  }
  const resolvedEmail = email ?? `unknown+${transactionId}@paddle.local`;

  const licenseKey = await createLicenseKey({
    email: resolvedEmail,
    transaction_id: transactionId,
    product: 'endstate-gui',
    issued_at: new Date().toISOString(),
  });

  try {
    await insertLicense({
      licenseKey,
      email: resolvedEmail,
      paddleTransactionId: transactionId,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Race with a concurrent delivery of the same webhook: the row exists now,
    // so treat this as a dedupe hit rather than a failure.
    if (msg.includes('duplicate key')) {
      return NextResponse.json({ ok: true, deduped: true }, { status: 200 });
    }
    return NextResponse.json(
      { error: 'internal_error', message: 'failed to store license' },
      { status: 500 },
    );
  }

  if (emailMissing) {
    return NextResponse.json(
      { ok: true, email_skipped: true },
      { status: 200 },
    );
  }

  // License row is committed — from here on, email failures must not cause a
  // non-2xx response. Paddle would retry and we'd hit the idempotency path
  // without ever getting the email out. Log and move on; resend manually.
  const rendered = renderLicenseKeyEmail({ licenseKey, email: resolvedEmail });
  const result = await sendTransactionalEmail({
    to: resolvedEmail,
    subject: rendered.subject,
    htmlContent: rendered.htmlContent,
    textContent: rendered.textContent,
  });

  if (!result.success) {
    console.error(
      `[license webhook] email send failed for transaction ${transactionId} (${resolvedEmail}): ${result.error}`,
    );
    return NextResponse.json(
      { ok: true, email_failed: true },
      { status: 200 },
    );
  }

  console.log(
    `[license webhook] sent license email for transaction ${transactionId} (${resolvedEmail}) messageId=${result.messageId ?? 'unknown'}`,
  );

  return NextResponse.json({ ok: true, messageId: result.messageId }, { status: 200 });
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
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

  let transactionId = 'unknown';
  let email: string | null = null;
  let customerId: string | null = null;
  try {
    ({ transactionId, email, customerId } = extractTransactionFields(event));
  } catch (err) {
    console.warn(
      '[supporter webhook] extractTransactionFields failed:',
      err instanceof Error ? err.message : err,
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
    to: 'founder@substratesystems.io',
    subject: `New Endstate supporter: ${email ?? 'unknown email'}`,
    htmlContent: `<p>New Supporter License purchase.</p><p>Email: ${esc(email ?? 'unknown')}<br/>Transaction: ${esc(transactionId)}</p><p>If they reply opting in, add their name to SUPPORTERS.md.</p>`,
    textContent: `New Supporter License purchase.\nEmail: ${email ?? 'unknown'}\nTransaction: ${transactionId}\nIf they reply opting in, add their name to SUPPORTERS.md.`,
  }).catch((err) =>
    console.error('[supporter webhook] founder notification failed:', err),
  );

  if (email) {
    await sendTransactionalEmail({
      to: email,
      subject: 'Thank you for supporting Endstate',
      htmlContent: `<p>Thank you for becoming an Endstate supporter. This directly funds development and keeps Endstate free for everyone — that's the whole pitch.</p><p>If you'd like your name listed publicly (supporters page + GitHub repo), just reply with the name you'd like shown. Prefer to stay anonymous? Nothing to do.</p><p>— Hugo</p>`,
      textContent: `Thank you for becoming an Endstate supporter. This directly funds development and keeps Endstate free for everyone — that's the whole pitch.\n\nIf you'd like your name listed publicly (supporters page + GitHub repo), just reply with the name you'd like shown. Prefer to stay anonymous? Nothing to do.\n\n— Hugo`,
    }).catch((err) =>
      console.error('[supporter webhook] thank-you email failed:', err),
    );
  }

  return NextResponse.json({ ok: true, supporter: true }, { status: 200 });
}
