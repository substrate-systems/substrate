import { NextRequest } from 'next/server';
import {
  errors,
  errorResponse,
  HostedBackupError,
} from '@/lib/hosted-backup/errors';
import {
  bumpClaimResend,
  verifyClaimToken,
} from '@/lib/hosted-backup/claim-tokens';
import { sendTransactionalEmail } from '@/lib/brevo';
import { renderResendClaimEmail } from '@/lib/email-templates/claim';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function extractBearerToken(req: NextRequest): string {
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) {
    throw errors.unauthenticated(
      'expected Authorization: Bearer <claimToken>',
    );
  }
  if (!header.toLowerCase().startsWith('bearer ')) {
    throw errors.unauthenticated('expected Bearer scheme');
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) throw errors.unauthenticated('empty Bearer token');
  return token;
}

export async function POST(req: NextRequest) {
  try {
    const claimToken = extractBearerToken(req);

    const verify = await verifyClaimToken(claimToken);
    if (verify.kind === 'invalid') throw errors.claimTokenInvalid();
    if (verify.kind === 'expired') throw errors.claimTokenExpired();
    if (verify.kind === 'consumed') throw errors.claimTokenConsumed();

    // The bump is the rate-limit gate: returns false if last_sent_at is
    // within the 60s window. We render+send only after the bump succeeds so
    // we never double-email on rapid clicks.
    const allowed = await bumpClaimResend(verify.row.token_hash);
    if (!allowed) {
      throw errors.rateLimited(
        'try again in a minute (resend rate limit)',
      );
    }

    const rendered = renderResendClaimEmail({
      email: verify.row.email,
      token: claimToken,
    });
    const send = await sendTransactionalEmail({
      to: verify.row.email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
    if (!send.success) {
      console.warn('[hosted-backup claim/resend] brevo failed', {
        error: send.error,
      });
      // Don't error the request — the row was bumped, the rate-limit window
      // closes, and the user can retry in 60s. Surface a soft failure for
      // the UI to show a "couldn't send, try again" toast.
      return jsonWithApiVersion(
        { ok: false, error: { code: 'EMAIL_SEND_FAILED', message: send.error ?? 'unknown' } },
        502,
      );
    }
    return jsonWithApiVersion({ ok: true }, 200);
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup claim/resend] unhandled:', err);
    }
    return errorResponse(err);
  }
}
