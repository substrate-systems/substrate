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
import { paddleFetch, assertOk } from './paddle-client';
import type { SubscriptionStatus } from './types';

type PaddleSubscriptionEventData = {
  id?: string; // paddle_subscription_id
  customer_id?: string;
  status?: string;
  next_billed_at?: string;
  canceled_at?: string;
  scheduled_change?: { effective_at?: string; action?: string };
  custom_data?: { user_id?: string } | null;
  passthrough?: string | { user_id?: string } | null;
  items?: Array<{ price?: { id?: string } }>;
};

export type PaddleSubscriptionEvent = {
  event_id: string;
  event_type: string;
  data?: PaddleSubscriptionEventData;
};

export type ApplyResult =
  | {
      kind: 'applied';
      userId: string;
      status: SubscriptionStatus;
      /**
       * Set when the user was resolved via the email-fallback path (only on
       * `subscription.created` for unauthenticated marketing-page checkouts).
       * `isNewPreAccount` is true when the users row was created by this very
       * event (no prior account for the email). Absent for the standard
       * custom_data / paddle_customer_id resolution paths.
       */
      preAccountFlow?: { resolvedByEmail: true; isNewPreAccount: boolean };
    }
  | { kind: 'unknown_user' }
  | { kind: 'ignored'; reason: string };

/**
 * Optional injection for unauthenticated checkout resolution. The webhook
 * route closes over Paddle API + ensurePreAccount and passes this in so the
 * pure state machine stays unaware of those concerns.
 */
export type EmailResolver = (
  customerId: string,
) => Promise<{ userId: string; isNew: boolean } | null>;

const HANDLED_EVENTS = new Set([
  'subscription.created',
  'subscription.activated',
  'subscription.past_due',
  'subscription.canceled',
  'subscription.paused',
  'subscription.resumed',
  'subscription.updated',
]);

export function isHandledEvent(eventType: string): boolean {
  return HANDLED_EVENTS.has(eventType);
}

function extractUserIdFromEvent(
  data: PaddleSubscriptionEventData | undefined,
): string | null {
  const direct = data?.custom_data?.user_id;
  if (typeof direct === 'string' && direct.length > 0) return direct;
  const pt = data?.passthrough;
  if (pt && typeof pt === 'object') {
    const uid = (pt as { user_id?: unknown }).user_id;
    if (typeof uid === 'string' && uid.length > 0) return uid;
  }
  if (typeof pt === 'string' && pt.length > 0) {
    try {
      const parsed = JSON.parse(pt) as { user_id?: unknown };
      if (typeof parsed.user_id === 'string' && parsed.user_id.length > 0) {
        return parsed.user_id;
      }
    } catch {
      // legacy passthrough that isn't JSON — ignore
    }
  }
  return null;
}

function extractPlan(
  data: PaddleSubscriptionEventData | undefined,
): string | null {
  const id = data?.items?.[0]?.price?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

/**
 * Applies a Paddle subscription event to our state machine. Returns a
 * structured result so the route handler can respond appropriately.
 *
 * `opts.resolveByEmail`, when provided, is used as a final-fallback
 * resolution for `subscription.created` events that carry no
 * custom_data.user_id and whose customer_id has no prior subscription row.
 * This is how the unauthenticated marketing-page checkout (no auth on
 * /endstate, no user_id in Paddle's custom_data) gets attached to a real
 * user_id — the route handler closes over fetchPaddleCustomerEmail +
 * ensurePreAccount and passes the result in.
 */
export async function applyPaddleEvent(
  event: PaddleSubscriptionEvent,
  opts?: { resolveByEmail?: EmailResolver },
): Promise<ApplyResult> {
  if (!isHandledEvent(event.event_type)) {
    return { kind: 'ignored', reason: `unhandled event type: ${event.event_type}` };
  }
  const subscriptionId = event.data?.id;
  const customerId = event.data?.customer_id;
  if (!subscriptionId || !customerId) {
    return { kind: 'ignored', reason: 'missing subscription_id or customer_id' };
  }

  // Resolve user. Prefer the GUI-supplied custom_data (or legacy passthrough)
  // so the very first subscription.created can land — at that point the
  // subscriptions row does not yet exist, so a paddle_customer_id lookup
  // would fail. Fall back to the lookup for events that originated from
  // outside our checkout flow (e.g. a Paddle-dashboard-initiated change).
  let userId = extractUserIdFromEvent(event.data);
  if (!userId) {
    userId = await findUserIdByPaddleCustomerId(customerId);
  }
  let preAccountFlow: { resolvedByEmail: true; isNewPreAccount: boolean } | undefined;
  if (
    !userId &&
    event.event_type === 'subscription.created' &&
    opts?.resolveByEmail
  ) {
    // Anonymous marketing-page checkout. Try the email-fallback path.
    const resolved = await opts.resolveByEmail(customerId);
    if (resolved) {
      userId = resolved.userId;
      preAccountFlow = { resolvedByEmail: true, isNewPreAccount: resolved.isNew };
    }
  }
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
    plan: extractPlan(event.data),
    graceStartedAt: transition.graceStartedAt,
    cancelStartedAt: transition.cancelStartedAt,
    currentPeriodEnd: transition.currentPeriodEnd,
  });

  const result: ApplyResult = preAccountFlow
    ? { kind: 'applied', userId, status: transition.status, preAccountFlow }
    : { kind: 'applied', userId, status: transition.status };
  return result;
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
    case 'subscription.resumed':
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
    case 'subscription.paused':
      return {
        status: 'paused',
        graceStartedAt: null,
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
      if (paddleStatus === 'paused') {
        return {
          status: 'paused',
          graceStartedAt: null,
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
  try {
    const res = await paddleFetch(
      `/subscriptions/${encodeURIComponent(paddleSubscriptionId)}/cancel`,
      {
        method: 'POST',
        body: JSON.stringify({ effective_from: 'immediately' }),
      },
    );
    await assertOk(res);
    return true;
  } catch (err) {
    console.error('[hosted-backup paddle cancel] failed:', err);
    return false;
  }
}

export const _internal = { mapEventToStatus, extractUserIdFromEvent, extractPlan, HANDLED_EVENTS };

// Test seam — re-export type for tests
export type { SubscriptionRow };
