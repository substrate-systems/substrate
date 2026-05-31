/**
 * GET /api/account/me — issue #59: the response must carry lastBackupAt + quota
 * (quotaUsedBytes / quotaTotalBytes / versionCount) so the GUI can show backup
 * freshness + a quota meter. Mocks the data layer (node:test module mocks) and
 * asserts the route maps the new fields through. A shared `state` lets each test
 * vary the stats without re-importing the (cached) route module.
 */

import { before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const QUOTA = 1024 * 1024 * 1024;
const state = {
  stats: { usedBytes: 0, versionCount: 0, lastBackupAt: null as string | null },
};

before(() => {
  mock.module('@/lib/hosted-backup/auth-middleware', {
    namedExports: {
      requireAuth: async () => ({ userId: 'user-1', subscriptionStatus: 'active', jti: 'j' }),
    },
  });
  mock.module('@/lib/hosted-backup/db', {
    namedExports: {
      findUserById: async () => ({
        id: 'user-1',
        email: 'u@example.com',
        created_at: '2026-01-01T00:00:00Z',
      }),
      getSubscriptionEntitlement: async () => ({
        effectiveStatus: 'active',
        plan: 'comp',
        currentPeriodEnd: null,
        gracePeriodEndsAt: null,
        paddleSubscriptionId: null,
        paddleCustomerId: null,
      }),
      getUserBackupStats: async () => state.stats,
    },
  });
  mock.module('@/lib/hosted-backup/storage', {
    namedExports: { getQuotaBytes: () => QUOTA },
  });
});

async function callGet() {
  const { GET } = await import('../route');
  const res = await GET(new Request('http://localhost/api/account/me') as never);
  return { res, body: (await res.json()) as Record<string, unknown> };
}

describe('GET /api/account/me — #59 freshness + quota', () => {
  it('maps lastBackupAt, quota usage/limit, and versionCount into the response', async () => {
    state.stats = { usedBytes: 272500, versionCount: 3, lastBackupAt: '2026-05-30T12:04:20Z' };
    const { res, body } = await callGet();
    assert.equal(res.status, 200);
    assert.equal(body.lastBackupAt, '2026-05-30T12:04:20Z');
    assert.equal(body.quotaUsedBytes, 272500);
    assert.equal(body.quotaTotalBytes, QUOTA);
    assert.equal(body.versionCount, 3);
    // existing fields still present
    assert.equal(body.userId, 'user-1');
    assert.equal(body.subscriptionStatus, 'active');
  });

  it('passes through a null lastBackupAt when the user has no versions', async () => {
    state.stats = { usedBytes: 0, versionCount: 0, lastBackupAt: null };
    const { body } = await callGet();
    assert.equal(body.lastBackupAt, null);
    assert.equal(body.quotaUsedBytes, 0);
    assert.equal(body.versionCount, 0);
  });
});
