/**
 * Tests for the backup-gc cron route: auth gate, R2-before-DB ordering in
 * Pass A, queue-drain semantics in Pass B, the abandoned-upload sweep in
 * Pass C, and the rate-limit prune in Pass D. State-based module mocks per
 * the account-deletion test pattern.
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

type GcState = {
  expiredVersions: Array<{ id: string; manifest_object_key: string }>;
  chunksByVersion: Record<string, Array<{ object_key: string }>>;
  hardDeletedVersionIds: string[];
  pendingPurges: Array<{ id: string; r2_prefix: string }>;
  purgesMarkedDone: string[];
  uncheckedVersions: Array<{ id: string; manifest_object_key: string }>;
  stampedVersionIds: string[];
  softDeletedVersionIds: string[];
  rateLimitPruned: number;
  r2DeletedKeys: string[][];
  r2DeleteFails: boolean;
  r2DeleteFailsOnce: boolean;
  // keys remaining under each prefix; shift()ed page by page as GC deletes
  r2ListPagesByPrefix: Record<string, string[][]>;
  headStateByKey: Record<string, 'present' | 'absent' | 'throw'>;
};

let state: GcState;

function setup(overrides: Partial<GcState> = {}) {
  state = {
    expiredVersions: [],
    chunksByVersion: {},
    hardDeletedVersionIds: [],
    pendingPurges: [],
    purgesMarkedDone: [],
    uncheckedVersions: [],
    stampedVersionIds: [],
    softDeletedVersionIds: [],
    rateLimitPruned: 0,
    r2DeletedKeys: [],
    r2DeleteFails: false,
    r2DeleteFailsOnce: false,
    r2ListPagesByPrefix: {},
    headStateByKey: {},
    ...overrides,
  };

  mock.module('../db', {
    namedExports: {
      findExpiredDeletedVersions: async () => state.expiredVersions,
      listChunksForVersion: async (versionId: string) =>
        state.chunksByVersion[versionId] ?? [],
      hardDeleteVersion: async (versionId: string) => {
        state.hardDeletedVersionIds.push(versionId);
        return 1;
      },
      findPendingPurges: async () => state.pendingPurges,
      markPurgeDone: async (id: string) => {
        state.purgesMarkedDone.push(id);
      },
      findUncheckedManifestVersions: async () => state.uncheckedVersions,
      stampManifestSeen: async (versionId: string) => {
        state.stampedVersionIds.push(versionId);
      },
      softDeleteVersionById: async (versionId: string) => {
        state.softDeletedVersionIds.push(versionId);
      },
      deleteRateLimitEventsBefore: async () => state.rateLimitPruned,
    },
  });

  mock.module('../r2', {
    namedExports: {
      deleteObjects: async (keys: string[]) => {
        if (state.r2DeleteFails) throw new Error('simulated R2 failure');
        if (state.r2DeleteFailsOnce) {
          state.r2DeleteFailsOnce = false;
          throw new Error('simulated one-shot R2 failure');
        }
        state.r2DeletedKeys.push(keys);
        return keys.length;
      },
      listObjectKeys: async (prefix: string) => {
        const pages = state.r2ListPagesByPrefix[prefix];
        if (!pages || pages.length === 0) return { keys: [] };
        return { keys: pages.shift()! };
      },
      headObjectExists: async (key: string) => {
        const s = state.headStateByKey[key] ?? 'present';
        if (s === 'throw') throw new Error('simulated transport error');
        return s;
      },
    },
  });
}

function authedReq() {
  return new Request('https://test.local/api/cron/backup-gc', {
    method: 'GET',
    headers: { authorization: 'Bearer s3cret' },
  }) as unknown as import('next/server').NextRequest;
}

async function runGc() {
  const { GET } = await import('../../../app/api/cron/backup-gc/route');
  return GET(authedReq());
}

beforeEach(() => {
  process.env.CRON_SECRET = 's3cret';
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  mock.reset();
});

describe('backup-gc — auth', () => {
  it('rejects without the bearer secret and performs no work', async () => {
    setup({
      expiredVersions: [{ id: 'v-1', manifest_object_key: 'm-1' }],
    });
    const { GET } = await import('../../../app/api/cron/backup-gc/route');
    const res = await GET(
      new Request('https://test.local/api/cron/backup-gc', {
        method: 'GET',
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 401);
    assert.deepEqual(state.hardDeletedVersionIds, []);
    assert.deepEqual(state.r2DeletedKeys, []);
  });
});

describe('backup-gc — Pass A (expired soft-deleted versions)', () => {
  it('deletes chunk + manifest objects from R2, then hard-deletes the rows', async () => {
    setup({
      expiredVersions: [{ id: 'v-1', manifest_object_key: 'u/m-1' }],
      chunksByVersion: {
        'v-1': [{ object_key: 'u/c-0' }, { object_key: 'u/c-1' }],
      },
    });
    const res = await runGc();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(state.r2DeletedKeys, [['u/c-0', 'u/c-1', 'u/m-1']]);
    assert.deepEqual(state.hardDeletedVersionIds, ['v-1']);
    assert.equal(body.expiredVersionsPurged, 1);
    assert.equal(body.expiredObjectsDeleted, 3);
    assert.equal(body.errorCount, 0);
  });

  it('keeps the DB rows when the R2 delete fails (retry next run)', async () => {
    setup({
      expiredVersions: [{ id: 'v-1', manifest_object_key: 'u/m-1' }],
      r2DeleteFails: true,
    });
    const res = await runGc();
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(state.hardDeletedVersionIds, []);
    assert.equal(body.expiredVersionsPurged, 0);
    assert.ok(body.errorCount >= 1);
  });

  it('a failing version does not block the rest of the batch', async () => {
    // First deleteObjects call throws, subsequent ones succeed.
    setup({
      expiredVersions: [
        { id: 'v-bad', manifest_object_key: 'u/m-bad' },
        { id: 'v-ok', manifest_object_key: 'u/m-ok' },
      ],
      r2DeleteFailsOnce: true,
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.hardDeletedVersionIds, ['v-ok']);
    assert.equal(body.expiredVersionsPurged, 1);
    assert.equal(body.errorCount, 1);
  });
});

describe('backup-gc — Pass B (purge queue)', () => {
  it('drains a prefix and marks it done only once it lists empty', async () => {
    setup({
      pendingPurges: [{ id: 'q-1', r2_prefix: 'users/u-1/' }],
      r2ListPagesByPrefix: {
        'users/u-1/': [['users/u-1/a', 'users/u-1/b']],
      },
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.r2DeletedKeys, [['users/u-1/a', 'users/u-1/b']]);
    assert.deepEqual(state.purgesMarkedDone, ['q-1']);
    assert.equal(body.purgeQueueMarkedDone, 1);
    assert.equal(body.purgeQueueObjectsDeleted, 2);
  });

  it('leaves an over-budget prefix pending for the next run', async () => {
    // More pages than PURGE_PAGES_PER_PREFIX (10) — list never goes empty.
    const pages = Array.from({ length: 20 }, (_, i) => [`users/u-2/k${i}`]);
    setup({
      pendingPurges: [{ id: 'q-2', r2_prefix: 'users/u-2/' }],
      r2ListPagesByPrefix: { 'users/u-2/': pages },
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.purgesMarkedDone, []);
    assert.equal(body.purgeQueueMarkedDone, 0);
    assert.equal(state.r2DeletedKeys.length, 10, 'one delete per page budget');
  });

  it('marks an already-empty prefix done without deleting anything', async () => {
    setup({
      pendingPurges: [{ id: 'q-3', r2_prefix: 'users/u-3/' }],
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.purgesMarkedDone, ['q-3']);
    assert.deepEqual(state.r2DeletedKeys, []);
    assert.equal(body.purgeQueueMarkedDone, 1);
  });
});

describe('backup-gc — Pass C (abandoned uploads)', () => {
  it('soft-deletes a version whose manifest is definitively absent', async () => {
    setup({
      uncheckedVersions: [{ id: 'v-gone', manifest_object_key: 'u/m-gone' }],
      headStateByKey: { 'u/m-gone': 'absent' },
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.softDeletedVersionIds, ['v-gone']);
    assert.deepEqual(state.stampedVersionIds, []);
    assert.equal(body.abandonedSoftDeleted, 1);
  });

  it('stamps manifest_seen_at for a healthy version', async () => {
    setup({
      uncheckedVersions: [{ id: 'v-ok', manifest_object_key: 'u/m-ok' }],
      headStateByKey: { 'u/m-ok': 'present' },
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.stampedVersionIds, ['v-ok']);
    assert.deepEqual(state.softDeletedVersionIds, []);
    assert.equal(body.manifestsStamped, 1);
  });

  it('changes nothing on a transport error', async () => {
    setup({
      uncheckedVersions: [{ id: 'v-unk', manifest_object_key: 'u/m-unk' }],
      headStateByKey: { 'u/m-unk': 'throw' },
    });
    const res = await runGc();
    const body = await res.json();
    assert.deepEqual(state.stampedVersionIds, []);
    assert.deepEqual(state.softDeletedVersionIds, []);
    assert.equal(body.errorCount, 1);
  });
});

describe('backup-gc — Pass D (rate-limit prune)', () => {
  it('reports the pruned-row count', async () => {
    setup({ rateLimitPruned: 42 });
    const res = await runGc();
    const body = await res.json();
    assert.equal(body.rateLimitEventsPruned, 42);
  });
});
