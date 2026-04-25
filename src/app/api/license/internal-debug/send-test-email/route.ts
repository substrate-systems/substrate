import { NextRequest, NextResponse } from 'next/server';
import { sendTransactionalEmail } from '@/lib/brevo';
import { renderLicenseKeyEmail } from '@/lib/email-templates/license-key';
import { createLicenseKey } from '@/lib/license/crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'method_not_allowed' },
    { status: 405, headers: { allow: 'POST' } },
  );
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.DEBUG_EMAIL_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: 'debug_route_disabled' },
      { status: 503 },
    );
  }

  if (req.headers.get('x-debug-secret') !== secret) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'bad_request', message: 'invalid JSON' },
      { status: 400 },
    );
  }

  const email = (body as { email?: unknown })?.email;
  if (typeof email !== 'string' || !email.includes('@')) {
    return NextResponse.json(
      { error: 'bad_request', message: 'email must be a string containing @' },
      { status: 400 },
    );
  }

  try {
    const licenseKey = await createLicenseKey({
      email,
      transaction_id: `debug-${Date.now()}`,
      product: 'endstate-gui',
      issued_at: new Date().toISOString(),
    });

    const rendered = renderLicenseKeyEmail({ licenseKey, email });
    const result = await sendTransactionalEmail({
      to: email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });

    return NextResponse.json(
      {
        ok: result.success,
        messageId: result.messageId ?? null,
        error: result.error ?? null,
        licenseKey,
        renderedSubject: rendered.subject,
        renderedHtmlBytes: rendered.htmlContent.length,
        renderedTextBytes: rendered.textContent.length,
      },
      { status: 200 },
    );
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}
