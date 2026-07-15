import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { displayPlanName } from './AccountView';

describe('displayPlanName', () => {
  it('does not expose an internal Paddle price ID as the plan name', () => {
    assert.equal(displayPlanName('pri_01ks03yq9ggsj4mdfdv3egwz67'), 'Hosted Backup');
  });

  it('preserves a human-readable plan name', () => {
    assert.equal(displayPlanName('Hosted Backup Plus'), 'Hosted Backup Plus');
  });
});
