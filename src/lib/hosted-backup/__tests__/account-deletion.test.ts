/**
 * Account deletion tests using node:test module mocks.
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

type DeletionState = {
  auditRows: Array<{ userIdHash: Uint8Array; reason: string }>;
  cascadedUserIds: string[];
  paddleCancelCalled: boolean;
  paddleCancelOk: boolean;
  subscriptionForUser: {
    paddle_subscription_id: string | null;
    status: string;
  } | null;
};

let state: DeletionState;

function setup(opts: {
  paddleCancelOk?: boolean;
  hasSubscription?: boolean;
} = {}) {
  state = {
    auditRows: [],
    cascadedUserIds: [],
    paddleCancelCalled: false,
    paddleCancelOk: opts.paddleCancelOk ?? true,
    subscriptionForUser: opts.hasSubscription
      ? { paddle_subscription_id: 'sub_xx', status: 'active' }
      : null,
  };
  mock.module('../db', {
    namedExports: {
      insertAccountDeletionAudit: async (params: {
        userIdHash: Uint8Array;
        reason: string;
      }) => {
        state.auditRows.push({
          userIdHash: params.userIdHash,
          reason: params.reason,
        });
      },
      deleteUserCascade: async (userId: string) => {
        state.cascadedUserIds.push(userId);
        return 1;
      },
      getSubscriptionByUserId: async () => state.subscriptionForUser,
    },
  });
  mock.module('../subscriptions', {
    namedExports: {
      cancelPaddleSubscription: async () => {
        state.paddleCancelCalled = true;
        return state.paddleCancelOk;
      },
    },
  });
}

afterEach(() => mock.reset());

describe('deleteAccount', () => {
  it('writes audit row with SHA-256(userId), then cascades and reports R2 prefix', async () => {
    setup();
    const { deleteAccount } = await import('../account-deletion');
    const userId = '00000000-0000-0000-0000-deadbeefcafe';
    const result = await deleteAccount(userId);

    assert.equal(state.auditRows.length, 1);
    const expected = new Uint8Array(
      createHash('sha256').update(userId, 'utf8').digest(),
    );
    assert.equal(state.auditRows[0].userIdHash.length, 32);
    assert.equal(
      Buffer.from(state.auditRows[0].userIdHash).toString('hex'),
      Buffer.from(expected).toString('hex'),
    );
    assert.equal(state.auditRows[0].reason, 'user_request');
    assert.deepEqual(state.cascadedUserIds, [userId]);
    assert.equal(result.deleted, true);
    assert.equal(result.r2PrefixForPurge, `users/${userId}/`);
  });

  it('proceeds with cascade even if Paddle cancel fails', async () => {
    setup({ paddleCancelOk: false, hasSubscription: true });
    const { deleteAccount } = await import('../account-deletion');
    const result = await deleteAccount('user-pdfail');
    assert.equal(state.paddleCancelCalled, true);
    assert.equal(result.paddleCancelled, false);
    assert.equal(result.deleted, true);
    assert.deepEqual(state.cascadedUserIds, ['user-pdfail']);
  });

  it('skips Paddle cancel when no active subscription', async () => {
    setup({ hasSubscription: false });
    const { deleteAccount } = await import('../account-deletion');
    const result = await deleteAccount('user-nosub');
    assert.equal(state.paddleCancelCalled, false);
    assert.equal(result.paddleCancelled, true); // "nothing to cancel" counts as success
    assert.equal(result.deleted, true);
  });
});
