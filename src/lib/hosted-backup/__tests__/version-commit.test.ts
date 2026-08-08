/**
 * Storage-layer behaviour of the two-phase version commit (contract §7, §8),
 * plus the request-header schema negotiation that decides which phase model a
 * caller gets.
 *
 * The `../db` mock here is a small in-memory row store rather than a set of
 * assertion stubs: it records `requires_commit` / `committed_at` and applies
 * the same visibility rule the SQL does, so the code under test
 * (`createVersionWithUploads`, `commitVersionUpload`) runs for real against
 * realistic rows. The SQL those functions call is separately exercised
 * against a live Postgres in `version-commit-postgres.integration.test.ts`.
 *
 * Requires `--experimental-test-module-mocks` (set in the npm test script).
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

process.env.ENDSTATE_R2_ENDPOINT = 'https://test-account.r2.cloudflarestorage.com';
process.env.ENDSTATE_R2_ACCESS_KEY_ID = 'AKIATESTKEY1234567890';
process.env.ENDSTATE_R2_SECRET_ACCESS_KEY = 'secret-test-key-very-long-string';
process.env.ENDSTATE_R2_BUCKET = 'endstate-backups-test';

type VersionRow = {
  id: string;
  backup_id: string;
  created_at: string;
  size_bytes: number;
  requires_commit: boolean;
  committed_at: string | null;
  deleted_at: string | null;
};

type Store = {
  backups: Map<string, { id: string; user_id: string }>;
  versions: VersionRow[];
  pruneCalls: number;
  clock: number;
};

let store: Store;

function visible(v: VersionRow): boolean {
  return v.deleted_at === null && (v.requires_commit === false || v.committed_at !== null);
}

function setupMocks() {
  store = { backups: new Map(), versions: [], pruneCalls: 0, clock: 0 };

  mock.module('../db', {
    namedExports: {
      getBackupOwned: async (userId: string, backupId: string) => {
        const b = store.backups.get(backupId);
        return b && b.user_id === userId ? { ...b, deleted_at: null } : null;
      },
      sumActiveStorageForUser: async (userId: string) =>
        store.versions
          .filter((v) => visible(v) && store.backups.get(v.backup_id)?.user_id === userId)
          .reduce((acc, v) => acc + v.size_bytes, 0),
      insertVersionWithChunks: async (params: {
        versionId: string;
        backupId: string;
        sizeBytes: number;
        requiresCommit?: boolean;
      }) => {
        store.clock += 1;
        const row: VersionRow = {
          id: params.versionId,
          backup_id: params.backupId,
          created_at: new Date(store.clock * 1000).toISOString(),
          size_bytes: params.sizeBytes,
          requires_commit: params.requiresCommit ?? false,
          committed_at: null,
          deleted_at: null,
        };
        store.versions.push(row);
        return row;
      },
      commitVersion: async (params: {
        userId: string;
        backupId: string;
        versionId: string;
      }) => {
        const row = store.versions.find(
          (v) =>
            v.id === params.versionId &&
            v.backup_id === params.backupId &&
            v.deleted_at === null &&
            store.backups.get(v.backup_id)?.user_id === params.userId,
        );
        if (!row) return null;
        if (row.committed_at !== null) {
          return { committedAt: row.committed_at, alreadyCommitted: true };
        }
        store.clock += 1;
        row.committed_at = new Date(store.clock * 1000).toISOString();
        return { committedAt: row.committed_at, alreadyCommitted: false };
      },
      softDeleteVersionsBeyondRetention: async (params: {
        backupId: string;
        retain: number;
      }) => {
        store.pruneCalls += 1;
        const keep = new Set(
          store.versions
            .filter((v) => v.backup_id === params.backupId && visible(v))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(0, params.retain)
            .map((v) => v.id),
        );
        let pruned = 0;
        for (const v of store.versions) {
          if (v.backup_id === params.backupId && visible(v) && !keep.has(v.id)) {
            v.deleted_at = new Date().toISOString();
            pruned += 1;
          }
        }
        return pruned;
      },
      // Unrelated exports imported by storage.ts.
      insertBackup: async () => ({}),
      listBackupsForUser: async () => [],
      deleteBackupOwned: async () => 1,
      updateBackupOwned: async () => null,
      listVersions: async (backupId: string) =>
        store.versions.filter((v) => v.backup_id === backupId && visible(v)),
      getVersionOwned: async () => null,
      listChunksForVersion: async () => [],
      softDeleteVersionOwned: async () => 1,
    },
  });
}

function seedBackup(userId: string, backupId: string) {
  store.backups.set(backupId, { id: backupId, user_id: userId });
}

async function push(opts: {
  userId: string;
  backupId: string;
  requiresCommit?: boolean;
  size?: number;
}) {
  const { createVersionWithUploads } = await import('../storage');
  return createVersionWithUploads({
    userId: opts.userId,
    backupId: opts.backupId,
    encryptedManifest: new Uint8Array(10),
    chunkMetadata: [{ index: 0, encryptedSize: opts.size ?? 100, sha256: 'aa'.repeat(32) }],
    requiresCommit: opts.requiresCommit,
  });
}

beforeEach(() => setupMocks());
afterEach(() => mock.reset());

describe('clientRequiresVersionCommit — schema negotiation', () => {
  const cases: Array<[string | null | undefined, boolean, string]> = [
    [null, false, 'absent header keeps the 2.0 single-phase behaviour'],
    [undefined, false, 'undefined header keeps the 2.0 behaviour'],
    ['', false, 'empty header keeps the 2.0 behaviour'],
    ['2.0', false, 'an explicit 2.0 client has no commit endpoint'],
    ['1.9', false, 'anything older than 2.1 opts out'],
    ['2.1', true, '2.1 is the first schema with the commit endpoint'],
    ['2.10', true, 'minor is compared numerically, not lexically'],
    ['3.0', true, 'a future major also commits'],
    ['  2.1  ', true, 'surrounding whitespace is tolerated'],
    ['banana', false, 'an unparseable header fails closed'],
    ['2', false, 'a major-only header fails closed'],
  ];

  for (const [header, expected, why] of cases) {
    it(`${JSON.stringify(header)} → ${expected} (${why})`, async () => {
      const { clientRequiresVersionCommit } = await import('../api-version');
      assert.equal(clientRequiresVersionCommit(header), expected);
    });
  }
});

describe('createVersionWithUploads — commit gating', () => {
  it('a 2.1 client gets an uncommitted version and NO retention prune', async () => {
    seedBackup('u-1', 'b-1');
    const result = await push({ userId: 'u-1', backupId: 'b-1', requiresCommit: true });

    assert.equal(result.requiresCommit, true);
    assert.equal(store.pruneCalls, 0, 'retention must not run before the bytes land');
    const row = store.versions.find((v) => v.id === result.versionId)!;
    assert.equal(row.requires_commit, true);
    assert.equal(row.committed_at, null);
    assert.equal(visible(row), false, 'the version is not yet visible');
  });

  it('a 2.0 client gets the verbatim old behaviour: visible now, pruned now', async () => {
    seedBackup('u-2', 'b-2');
    const result = await push({ userId: 'u-2', backupId: 'b-2', requiresCommit: false });

    assert.equal(result.requiresCommit, false);
    assert.equal(store.pruneCalls, 1, 'a client with no commit call still gets §8 retention');
    const row = store.versions.find((v) => v.id === result.versionId)!;
    assert.equal(row.requires_commit, false);
    assert.equal(visible(row), true, 'visible with no commit call — the compatibility case');
  });

  it('defaults to the 2.0 behaviour when the caller says nothing', async () => {
    seedBackup('u-3', 'b-3');
    const result = await push({ userId: 'u-3', backupId: 'b-3' });
    assert.equal(result.requiresCommit, false);
    assert.equal(store.pruneCalls, 1);
  });

  it('an uncommitted version does not consume quota', async () => {
    seedBackup('u-4', 'b-4');
    const created = await push({
      userId: 'u-4',
      backupId: 'b-4',
      requiresCommit: true,
      size: 1000,
    });
    const { sumActiveStorageForUser } = await import('../db');
    assert.equal(await sumActiveStorageForUser('u-4'), 0, 'nothing is charged before commit');

    const { commitVersionUpload } = await import('../storage');
    await commitVersionUpload({
      userId: 'u-4',
      backupId: 'b-4',
      versionId: created.versionId,
    });
    assert.equal(
      await sumActiveStorageForUser('u-4'),
      1010,
      'charged only once the bytes are confirmed (1000 chunk + 10 manifest)',
    );
  });
});

describe('commitVersionUpload — publish + retention', () => {
  it('makes the version visible and prunes retention exactly once', async () => {
    seedBackup('u-5', 'b-5');
    const created = await push({ userId: 'u-5', backupId: 'b-5', requiresCommit: true });
    const { commitVersionUpload } = await import('../storage');

    const first = await commitVersionUpload({
      userId: 'u-5',
      backupId: 'b-5',
      versionId: created.versionId,
    });
    assert.equal(first.alreadyCommitted, false);
    assert.equal(typeof first.committedAt, 'string');
    assert.equal(store.pruneCalls, 1, 'retention runs on commit, not on create');
    assert.equal(visible(store.versions[0]), true);
  });

  it('is idempotent: a replay re-prunes nothing and keeps the original timestamp', async () => {
    seedBackup('u-6', 'b-6');
    const created = await push({ userId: 'u-6', backupId: 'b-6', requiresCommit: true });
    const { commitVersionUpload } = await import('../storage');

    const first = await commitVersionUpload({
      userId: 'u-6',
      backupId: 'b-6',
      versionId: created.versionId,
    });
    const second = await commitVersionUpload({
      userId: 'u-6',
      backupId: 'b-6',
      versionId: created.versionId,
    });

    assert.equal(second.alreadyCommitted, true);
    assert.equal(second.committedAt, first.committedAt);
    assert.equal(second.prunedVersions, 0);
    assert.equal(store.pruneCalls, 1, 'the destructive half runs at most once');
  });

  it('a failed push evicts nothing — the previous good version survives', async () => {
    seedBackup('u-7', 'b-7');
    const good: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const created = await push({ userId: 'u-7', backupId: 'b-7', requiresCommit: true });
      const { commitVersionUpload } = await import('../storage');
      await commitVersionUpload({
        userId: 'u-7',
        backupId: 'b-7',
        versionId: created.versionId,
      });
      good.push(created.versionId);
    }
    const pruneCallsAfterGoodPushes = store.pruneCalls;

    // Sixth push dies before commit.
    await push({ userId: 'u-7', backupId: 'b-7', requiresCommit: true });

    assert.equal(store.pruneCalls, pruneCallsAfterGoodPushes, 'no prune was triggered');
    const stillVisible = store.versions.filter(visible).map((v) => v.id);
    assert.deepEqual([...stillVisible].sort(), [...good].sort());
  });

  it('cross-user commit is NOT_FOUND, and leaves the owner untouched', async () => {
    seedBackup('u-8', 'b-8');
    const created = await push({ userId: 'u-8', backupId: 'b-8', requiresCommit: true });
    const { commitVersionUpload } = await import('../storage');

    await assert.rejects(
      commitVersionUpload({
        userId: 'attacker',
        backupId: 'b-8',
        versionId: created.versionId,
      }),
      (err: Error) => (err as unknown as { code: string }).code === 'NOT_FOUND',
    );
    assert.equal(store.pruneCalls, 0, 'a rejected commit must not prune anything');
    assert.equal(store.versions[0].committed_at, null);
  });

  it('an unknown version id is NOT_FOUND', async () => {
    seedBackup('u-9', 'b-9');
    const { commitVersionUpload } = await import('../storage');
    await assert.rejects(
      commitVersionUpload({ userId: 'u-9', backupId: 'b-9', versionId: 'no-such-version' }),
      (err: Error) => (err as unknown as { code: string }).code === 'NOT_FOUND',
    );
  });
});
