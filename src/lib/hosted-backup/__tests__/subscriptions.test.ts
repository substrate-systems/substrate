import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internal, type PaddleSubscriptionEvent } from '../subscriptions';

const { mapEventToStatus, extractUserIdFromEvent, extractPlan } = _internal;

function ev(eventType: string, data: object = {}): PaddleSubscriptionEvent {
  return {
    event_id: 'evt_test',
    event_type: eventType,
    data: { id: 'sub_x', customer_id: 'cus_x', ...data },
  };
}

describe('mapEventToStatus', () => {
  it('subscription.created → active', () => {
    const t = mapEventToStatus(ev('subscription.created'));
    assert.ok(t);
    assert.equal(t!.status, 'active');
    assert.equal(t!.cancelStartedAt, null);
    assert.equal(t!.graceStartedAt, null);
  });

  it('subscription.activated → active', () => {
    const t = mapEventToStatus(ev('subscription.activated'));
    assert.ok(t);
    assert.equal(t!.status, 'active');
  });

  it('subscription.past_due → grace with grace_started_at set', () => {
    const t = mapEventToStatus(ev('subscription.past_due'));
    assert.ok(t);
    assert.equal(t!.status, 'grace');
    assert.ok(t!.graceStartedAt instanceof Date);
  });

  it("Paddle's `canceled` (one l) maps to internal `cancelled` (two l's)", () => {
    const t = mapEventToStatus(ev('subscription.canceled'));
    assert.ok(t);
    assert.equal(t!.status, 'cancelled');
    assert.ok(t!.cancelStartedAt instanceof Date);
  });

  it('subscription.updated with status active → active', () => {
    const t = mapEventToStatus(ev('subscription.updated', { status: 'active' }));
    assert.ok(t);
    assert.equal(t!.status, 'active');
  });

  it('subscription.updated with status canceled → cancelled', () => {
    const t = mapEventToStatus(ev('subscription.updated', { status: 'canceled' }));
    assert.ok(t);
    assert.equal(t!.status, 'cancelled');
  });

  it('unknown event_type → null', () => {
    const t = mapEventToStatus(ev('subscription.unknown_thing'));
    assert.equal(t, null);
  });

  it('current_period_end is parsed from next_billed_at', () => {
    const t = mapEventToStatus(
      ev('subscription.created', { next_billed_at: '2026-06-01T00:00:00Z' }),
    );
    assert.ok(t);
    assert.ok(t!.currentPeriodEnd instanceof Date);
    assert.equal(
      t!.currentPeriodEnd!.toISOString(),
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('prefers current_billing_period.ends_at over next_billed_at', () => {
    const t = mapEventToStatus(
      ev('subscription.updated', {
        status: 'active',
        next_billed_at: null,
        current_billing_period: {
          starts_at: '2026-07-14T00:00:00Z',
          ends_at: '2026-08-14T00:00:00Z',
        },
      }),
    );
    assert.ok(t);
    assert.equal(t.currentPeriodEnd?.toISOString(), '2026-08-14T00:00:00.000Z');
  });

  it('keeps active status and captures a scheduled cancellation', () => {
    const t = mapEventToStatus(
      ev('subscription.updated', {
        status: 'active',
        current_billing_period: {
          starts_at: '2026-07-14T00:00:00Z',
          ends_at: '2026-08-14T00:00:00Z',
        },
        scheduled_change: {
          action: 'cancel',
          effective_at: '2026-08-14T00:00:00Z',
        },
      }),
    );
    assert.ok(t);
    assert.equal(t.status, 'active');
    assert.equal(t.scheduledCancelAt?.toISOString(), '2026-08-14T00:00:00.000Z');
  });

  it('clears scheduled cancellation when Paddle has no cancel change', () => {
    const t = mapEventToStatus(
      ev('subscription.updated', {
        status: 'active',
        scheduled_change: null,
      }),
    );
    assert.ok(t);
    assert.equal(t.scheduledCancelAt, null);
  });

  it('ignores scheduled changes that are not cancellation', () => {
    const t = mapEventToStatus(
      ev('subscription.updated', {
        status: 'active',
        scheduled_change: {
          action: 'pause',
          effective_at: '2026-08-14T00:00:00Z',
        },
      }),
    );
    assert.ok(t);
    assert.equal(t.scheduledCancelAt, null);
  });

  it('subscription.paused → paused', () => {
    const t = mapEventToStatus(ev('subscription.paused'));
    assert.ok(t);
    assert.equal(t!.status, 'paused');
    assert.equal(t!.graceStartedAt, null);
    assert.equal(t!.cancelStartedAt, null);
  });

  it('subscription.resumed → active', () => {
    const t = mapEventToStatus(ev('subscription.resumed'));
    assert.ok(t);
    assert.equal(t!.status, 'active');
    assert.equal(t!.graceStartedAt, null);
  });

  it('subscription.updated with paddle status paused → paused', () => {
    const t = mapEventToStatus(ev('subscription.updated', { status: 'paused' }));
    assert.ok(t);
    assert.equal(t!.status, 'paused');
  });
});

describe('extractUserIdFromEvent', () => {
  it('reads custom_data.user_id when present', () => {
    assert.equal(
      extractUserIdFromEvent({ custom_data: { user_id: 'u-1' } }),
      'u-1',
    );
  });

  it('reads passthrough.user_id when passthrough is an object', () => {
    assert.equal(
      extractUserIdFromEvent({ passthrough: { user_id: 'u-2' } }),
      'u-2',
    );
  });

  it('reads passthrough.user_id when passthrough is a JSON string', () => {
    assert.equal(
      extractUserIdFromEvent({ passthrough: JSON.stringify({ user_id: 'u-3' }) }),
      'u-3',
    );
  });

  it('returns null when neither custom_data nor passthrough carries user_id', () => {
    assert.equal(extractUserIdFromEvent({}), null);
  });

  it('returns null when passthrough is a non-JSON string', () => {
    assert.equal(extractUserIdFromEvent({ passthrough: 'legacy-noise' }), null);
  });

  it('prefers custom_data over passthrough', () => {
    assert.equal(
      extractUserIdFromEvent({
        custom_data: { user_id: 'u-cd' },
        passthrough: { user_id: 'u-pt' },
      }),
      'u-cd',
    );
  });
});

describe('extractPlan', () => {
  it('returns the first item price id', () => {
    assert.equal(
      extractPlan({ items: [{ price: { id: 'pri_x' } }] }),
      'pri_x',
    );
  });

  it('returns null when no items', () => {
    assert.equal(extractPlan({}), null);
  });

  it('returns null when first item has no price id', () => {
    assert.equal(extractPlan({ items: [{ price: {} }] }), null);
  });
});
