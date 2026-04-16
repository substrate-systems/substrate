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
