import { NextRequest, NextResponse } from 'next/server';
import { createLicenseKey } from '@/lib/license/crypto';
import {
  findLicenseByTransactionId,
  insertLicense,
} from '@/lib/license/db';
import { sendLicenseEmail } from '@/lib/license/email';
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

  const existing = await findLicenseByTransactionId(transactionId);
  if (existing) {
    return NextResponse.json({ ok: true, deduped: true }, { status: 200 });
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

  try {
    await sendLicenseEmail({ to: resolvedEmail, licenseKey });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'email_failed',
        message: err instanceof Error ? err.message : 'email failed',
      },
      { status: 500 },
    );
  }

  return NextResponse.json({ ok: true }, { status: 200 });
}
