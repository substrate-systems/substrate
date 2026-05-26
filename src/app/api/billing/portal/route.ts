import { NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { requireAccountSession } from '@/lib/hosted-backup/account-middleware';
import { getSubscriptionEntitlement } from '@/lib/hosted-backup/db';
import {
  paddleFetch,
  PaddleApiError,
} from '@/lib/hosted-backup/paddle-client';
import { jsonWithApiVersion } from '@/lib/hosted-backup/api-version';
import {
  errorResponse,
  HostedBackupError,
  errors,
} from '@/lib/hosted-backup/errors';
import type { BillingPortalResponse } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Mints a Paddle customer-portal session URL for the cookie-authenticated
// user. Called by `/account`'s "Manage in Paddle" button (active/grace
// states). The cancelled-state path uses POST /api/billing/checkout instead
// because Paddle's portal doesn't reactivate fully-canceled subscriptions.
//
// 404 with PADDLE_PORTAL_UNAVAILABLE when the user has no
// `paddle_customer_id` on file (e.g. pre-first-payment or sandbox seed
// user). The /account UI should branch on this and fall back to checkout.
export async function POST(_req: NextRequest) {
  try {
    const { userId } = await requireAccountSession(await cookies());
    const ent = await getSubscriptionEntitlement(userId);
    if (!ent.paddleCustomerId) {
      throw errors.paddlePortalUnavailable();
    }

    // Paddle Billing API: POST /customers/{id}/portal-sessions. Optional
    // `subscription_ids` narrows the portal to specific subs; we pass the
    // user's only subscription when present so the portal lands on its
    // management view directly.
    const body: { subscription_ids?: string[] } = ent.paddleSubscriptionId
      ? { subscription_ids: [ent.paddleSubscriptionId] }
      : {};
    const res = await paddleFetch(
      `/customers/${encodeURIComponent(ent.paddleCustomerId)}/portal-sessions`,
      { method: 'POST', body: JSON.stringify(body) },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new PaddleApiError(res.status, text);
    }
    const payload = (await res.json()) as {
      data?: { urls?: { general?: { overview?: string } } };
    };
    const portalUrl = payload?.data?.urls?.general?.overview;
    if (!portalUrl) {
      throw new HostedBackupError({
        code: 'PADDLE_API_ERROR',
        status: 502,
        message: 'paddle portal-session response missing urls.general.overview',
      });
    }

    const response: BillingPortalResponse = { portalUrl };
    return jsonWithApiVersion(response, 200);
  } catch (err) {
    if (err instanceof PaddleApiError) {
      const wrapped = new HostedBackupError({
        code: 'PADDLE_API_ERROR',
        status: 502,
        message: 'paddle portal-session creation failed',
        detail: { paddleStatus: err.status, paddleBody: err.body },
      });
      return errorResponse(wrapped);
    }
    if (!(err instanceof HostedBackupError)) {
      console.error('[hosted-backup billing/portal] unhandled:', err);
    }
    return errorResponse(err);
  }
}
