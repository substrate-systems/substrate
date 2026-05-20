/**
 * Builds a Paddle hosted-checkout URL for an authenticated hosted-backup user.
 *
 * The flow:
 *   1. GUI calls POST /api/billing/checkout (authenticated).
 *   2. This module creates a Paddle Transaction via the Billing API with the
 *      caller's internal user_id embedded in `custom_data.user_id`.
 *   3. Paddle returns a checkout URL that the GUI opens in its embedded
 *      browser.
 *   4. After the user completes payment, Paddle emits subscription.created
 *      to /api/webhooks/paddle, carrying the same `custom_data.user_id`,
 *      so applyPaddleEvent can correlate the new subscription to the user
 *      on the very first event.
 *
 * Paddle docs: https://developer.paddle.com/api-reference/transactions/create-transaction
 */

import { paddleFetch, assertOk } from './paddle-client';

export type CreateCheckoutParams = {
  userId: string;
  priceId: string;
  successUrl?: string;
};

export type CreateCheckoutResult = {
  checkoutUrl: string;
  transactionId: string;
};

type PaddleTransactionResponse = {
  data?: {
    id?: string;
    checkout?: { url?: string };
  };
};

export async function createCheckoutTransaction(
  params: CreateCheckoutParams,
): Promise<CreateCheckoutResult> {
  const body: Record<string, unknown> = {
    items: [{ price_id: params.priceId, quantity: 1 }],
    custom_data: { user_id: params.userId },
    collection_mode: 'automatic',
  };
  if (params.successUrl) {
    body.checkout = { url: params.successUrl };
  }

  const res = await paddleFetch('/transactions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await assertOk(res);
  const parsed = (await res.json()) as PaddleTransactionResponse;
  const transactionId = parsed.data?.id;
  const checkoutUrl = parsed.data?.checkout?.url;
  if (!transactionId || !checkoutUrl) {
    throw new Error(
      `paddle transaction response missing id or checkout.url: ${JSON.stringify(parsed)}`,
    );
  }
  return { transactionId, checkoutUrl };
}
