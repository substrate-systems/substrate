import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireAccountSession } from '@/lib/hosted-backup/account-middleware';
import { createCheckoutTransaction } from '@/lib/hosted-backup/checkout';
import { PaddleApiError } from '@/lib/hosted-backup/paddle-client';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import {
  errorResponse,
  HostedBackupError,
} from '@/lib/hosted-backup/errors';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cookie-authenticated sibling of POST /api/billing/checkout so the /account
// web page's "Resubscribe" / "Subscribe" button can mint a checkout without
// the engine round-trip. Same lib call (`createCheckoutTransaction`), same
// response shape — only the auth surface differs. The engine flow stays
// bearer-only; this sibling exists exclusively for the in-browser path.
// Mirrors the dual-auth split already established by
// DELETE /api/account (bearer) ↔ POST /api/account/web-delete (cookie).
export async function POST(_req: NextRequest) {
  try {
    const { userId } = await requireAccountSession(await cookies());
    const priceId = process.env.PADDLE_PRICE_ID_HOSTED_BACKUP;
    if (!priceId) {
      throw new HostedBackupError({
        code: 'SERVER_MISCONFIGURED',
        status: 500,
        message: 'PADDLE_PRICE_ID_HOSTED_BACKUP is not set',
      });
    }
    const successUrl = process.env.PADDLE_CHECKOUT_SUCCESS_URL || undefined;
    try {
      const { checkoutUrl, transactionId } = await createCheckoutTransaction({
        userId,
        priceId,
        successUrl,
      });
      return jsonWithApiVersion({ checkoutUrl, transactionId }, 200);
    } catch (err) {
      if (err instanceof PaddleApiError) {
        throw new HostedBackupError({
          code: 'PADDLE_API_ERROR',
          status: 502,
          message: 'paddle checkout creation failed',
          detail: { paddleStatus: err.status, paddleBody: err.body },
        });
      }
      throw err;
    }
  } catch (err) {
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup web-checkout] unhandled:', err);
    }
    return errorResponse(err);
  }
}
