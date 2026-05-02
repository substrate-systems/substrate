/**
 * Subscription state machine and Paddle event mapping per contract §10.
 *
 * Internal spelling is `cancelled` (two l's). Paddle's wire format is
 * `subscription.canceled` (one l). The mapping happens once at the boundary,
 * here.
 */

import {
  findUserIdByPaddleCustomerId,
  upsertSubscription,
  type SubscriptionRow,
} from './db';
import type { SubscriptionStatus } from './types';

type PaddleSubscriptionEventData = {
  id?: string; // paddle_subscription_id
  customer_id?: string;
  status?: string;
  next_billed_at?: string;
  canceled_at?: string;
  scheduled_change?: { effective_at?: string; action?: string };
};

export type PaddleSubscriptionEvent = {
  event_id: string;
  event_type: string;
  data?: PaddleSubscriptionEventData;
};

export type ApplyResult =
  | { kind: 'applied'; userId: string; status: SubscriptionStatus }
  | { kind: 'unknown_user' }
  | { kind: 'ignored'; reason: string };

const HANDLED_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.past_due',
  'subscription.canceled',
  'subscription.updated',
]);

export function isHandledEvent(eventType: string): boolean {
  return HANDLED_EVENTS.has(eventType);
}

/**
 * Applies a Paddle subscription event to our state machine. Returns a
 * structured result so the route handler can respond appropriately.
 */
export async function applyPaddleEvent(
  event: PaddleSubscriptionEvent,
): Promise<ApplyResult> {
  if (!isHandledEvent(event.event_type)) {
    return { kind: 'ignored', reason: `unhandled event type: ${event.event_type}` };
  }
  const subscriptionId = event.data?.id;
  const customerId = event.data?.customer_id;
  if (!subscriptionId || !customerId) {
    return { kind: 'ignored', reason: 'missing subscription_id or customer_id' };
  }

  // Resolve user. We expect an existing subscriptions row keyed by
  // paddle_customer_id (set during signup checkout). For first-time
  // subscription.created, the row may not exist yet — in that case we cannot
  // proceed and surface unknown_user; Paddle will retry until it succeeds.
  const userId = await findUserIdByPaddleCustomerId(customerId);
  if (!userId) {
    return { kind: 'unknown_user' };
  }

  const transition = mapEventToStatus(event);
  if (!transition) {
    return {
      kind: 'ignored',
      reason: `event ${event.event_type} did not map to a transition`,
    };
  }

  await upsertSubscription({
    userId,
    paddleSubscriptionId: subscriptionId,
    paddleCustomerId: customerId,
    status: transition.status,
    graceStartedAt: transition.graceStartedAt,
    cancelStartedAt: transition.cancelStartedAt,
    currentPeriodEnd: transition.currentPeriodEnd,
  });

  return { kind: 'applied', userId, status: transition.status };
}

type Transition = {
  status: SubscriptionStatus;
  graceStartedAt: Date | null;
  cancelStartedAt: Date | null;
  currentPeriodEnd: Date | null;
};

function mapEventToStatus(event: PaddleSubscriptionEvent): Transition | null {
  const now = new Date();
  const periodEnd = event.data?.next_billed_at
    ? new Date(event.data.next_billed_at)
    : null;
  switch (event.event_type) {
    case 'subscription.created':
    case 'subscription.activated':
      return {
        status: 'active',
        graceStartedAt: null,
        cancelStartedAt: null,
        currentPeriodEnd: periodEnd,
      };
    case 'subscription.past_due':
      return {
        status: 'grace',
        graceStartedAt: now,
        cancelStartedAt: null,
        currentPeriodEnd: periodEnd,
      };
    case 'subscription.canceled':
      // Paddle's spelling, one l. Internal: cancelled, two l's.
      return {
        status: 'cancelled',
        graceStartedAt: null,
        cancelStartedAt: event.data?.canceled_at
          ? new Date(event.data.canceled_at)
          : now,
        currentPeriodEnd: periodEnd,
      };
    case 'subscription.updated': {
      // Paddle's status field carries the canonical state; map it.
      const paddleStatus = event.data?.status;
      if (paddleStatus === 'active') {
        return {
          status: 'active',
          graceStartedAt: null,
          cancelStartedAt: null,
          currentPeriodEnd: periodEnd,
        };
      }
      if (paddleStatus === 'past_due') {
        return {
          status: 'grace',
          graceStartedAt: now,
          cancelStartedAt: null,
          currentPeriodEnd: periodEnd,
        };
      }
      if (paddleStatus === 'canceled') {
        return {
          status: 'cancelled',
          graceStartedAt: null,
          cancelStartedAt: now,
          currentPeriodEnd: periodEnd,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Best-effort Paddle subscription cancel. Logs and returns false on failure.
 */
export async function cancelPaddleSubscription(
  paddleSubscriptionId: string,
): Promise<boolean> {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    console.error(
      '[hosted-backup paddle cancel] PADDLE_API_KEY not set; cannot cancel',
    );
    return false;
  }
  try {
    const res = await fetch(
      `https://api.paddle.com/subscriptions/${encodeURIComponent(paddleSubscriptionId)}/cancel`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ effective_from: 'immediately' }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(
        `[hosted-backup paddle cancel] failed ${res.status}: ${body}`,
      );
      return false;
    }
    return true;
  } catch (err) {
    console.error('[hosted-backup paddle cancel] threw:', err);
    return false;
  }
}

export const _internal = { mapEventToStatus, HANDLED_EVENTS };

// Test seam — re-export type for tests
export type { SubscriptionRow };
