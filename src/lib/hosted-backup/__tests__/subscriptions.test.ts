import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { _internal, type PaddleSubscriptionEvent } from '../subscriptions';

const { mapEventToStatus } = _internal;

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
});
