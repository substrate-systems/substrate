/**
 * PATCH /api/backups/:id — rename (the first use of the general
 * update-backup-metadata primitive). Mocks the auth + storage layers
 * (node:test module mocks) and asserts the route validates the body,
 * forwards a partial `patch` to `updateBackup`, and maps not-found → 404.
 *
 * Rename uses requireReadAccess (mirrors DELETE): managing an existing
 * backup is allowed in any non-`none` subscription state, and rename is
 * strictly less destructive than delete.
 */

import { before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from '@/lib/hosted-backup/errors';

const state = {
  updateImpl: async (_p: unknown) => ({
    id: 'b-1',
    name: 'Renamed',
    updatedAt: '2026-06-05T12:00:00Z',
  }),
  lastArgs: null as unknown,
};

before(() => {
  mock.module('@/lib/hosted-backup/auth-middleware', {
    namedExports: {
      requireReadAccess: async () => ({
        userId: 'user-1',
        subscriptionStatus: 'active',
        jti: 'j',
      }),
    },
  });
  mock.module('@/lib/hosted-backup/storage', {
    namedExports: {
      updateBackup: async (p: unknown) => {
        state.lastArgs = p;
        return state.updateImpl(p);
      },
    },
  });
});

beforeEach(() => {
  state.lastArgs = null;
  state.updateImpl = async () => ({
    id: 'b-1',
    name: 'Renamed',
    updatedAt: '2026-06-05T12:00:00Z',
  });
});

async function callPatch(body: unknown, backupId = 'b-1') {
  const { PATCH } = await import('../route');
  const req = new Request(`http://localhost/api/backups/${backupId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const res = await PATCH(req as never, {
    params: Promise.resolve({ backupId }),
  });
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* no body */
  }
  return { res, body: parsed };
}

describe('PATCH /api/backups/:id — rename', () => {
  it('renames: forwards a partial { name } patch and echoes the new name', async () => {
    const { res, body } = await callPatch({ name: 'Gaming Rig' });
    assert.equal(res.status, 200);
    assert.equal(body?.name, 'Renamed'); // from the mocked storage echo
    assert.deepEqual(state.lastArgs, {
      userId: 'user-1',
      backupId: 'b-1',
      patch: { name: 'Gaming Rig' },
    });
  });

  it('trims surrounding whitespace before forwarding the name', async () => {
    await callPatch({ name: '  Work Laptop  ' });
    assert.deepEqual(state.lastArgs, {
      userId: 'user-1',
      backupId: 'b-1',
      patch: { name: 'Work Laptop' },
    });
  });

  it('rejects a missing name with 400 and does not touch storage', async () => {
    const { res } = await callPatch({});
    assert.equal(res.status, 400);
    assert.equal(state.lastArgs, null);
  });

  it('rejects a blank (whitespace-only) name with 400', async () => {
    const { res } = await callPatch({ name: '   ' });
    assert.equal(res.status, 400);
    assert.equal(state.lastArgs, null);
  });

  it('rejects an over-long name with 400', async () => {
    const { res } = await callPatch({ name: 'x'.repeat(201) });
    assert.equal(res.status, 400);
    assert.equal(state.lastArgs, null);
  });

  it('maps a not-found / not-owned backup to 404', async () => {
    state.updateImpl = async () => {
      throw errors.notFound('backup not found');
    };
    const { res } = await callPatch({ name: 'Whatever' });
    assert.equal(res.status, 404);
  });
});
