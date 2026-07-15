import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { dateLineText, displayPlanName, statusVisual } from './AccountView';

describe('displayPlanName', () => {
  it('does not expose an internal Paddle price ID as the plan name', () => {
    assert.equal(displayPlanName('pri_01ks03yq9ggsj4mdfdv3egwz67'), 'Hosted Backup');
  });

  it('preserves a human-readable plan name', () => {
    assert.equal(displayPlanName('Hosted Backup Plus'), 'Hosted Backup Plus');
  });
});

describe('scheduled cancellation presentation', () => {
  it('shows an amber Cancelling state while the entitlement remains active', () => {
    assert.deepEqual(statusVisual('active', '2026-08-14T00:00:00Z'), {
      tone: 'warning',
      label: 'Cancelling',
    });
  });

  it('describes access through the scheduled cancellation date instead of renewal', () => {
    assert.equal(
      dateLineText({
        status: 'active',
        periodEnd: 'August 14, 2026',
        graceEnd: null,
        scheduledCancelAt: 'August 14, 2026',
      }),
      'Access remains active through August 14, 2026.',
    );
  });

  it('keeps the normal active renewal presentation without a scheduled cancellation', () => {
    assert.deepEqual(statusVisual('active', null), {
      tone: 'positive',
      label: 'Active',
    });
    assert.equal(
      dateLineText({
        status: 'active',
        periodEnd: 'August 14, 2026',
        graceEnd: null,
        scheduledCancelAt: null,
      }),
      'Renews August 14, 2026.',
    );
  });
});
