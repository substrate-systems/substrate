/**
 * Storage layer tests using node:test module mocks.
 *
 * Requires `--experimental-test-module-mocks` in the test runner (already
 * set in the npm test script).
 */

import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

// R2 env vars must be set so the lazy R2 client can be constructed if any
// presign helper is invoked (most of these tests don't reach R2 because
// validation fails before that point, but the manifest-PUT path does).
process.env.ENDSTATE_R2_ENDPOINT = 'https://test-account.r2.cloudflarestorage.com';
process.env.ENDSTATE_R2_ACCESS_KEY_ID = 'AKIATESTKEY1234567890';
process.env.ENDSTATE_R2_SECRET_ACCESS_KEY = 'secret-test-key-very-long-string';
process.env.ENDSTATE_R2_BUCKET = 'endstate-backups-test';

type FakeBackupRow = {
  id: string;
  user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};

type FakeVersionRow = {
  id: string;
  backup_id: string;
  created_at: string;
  size_bytes: number;
  manifest_object_key: string;
  manifest_sha256: Uint8Array;
  chunk_count: number;
  deleted_at: string | null;
};

type FakeChunkRow = {
  version_id: string;
  chunk_index: number;
  object_key: string;
  size_bytes: number;
  sha256: Uint8Array;
};

type DbMockState = {
  ownedBackups: Map<string, FakeBackupRow>;
  totalSize: number;
  insertedVersion: FakeVersionRow | null;
  softDeletedBeyondRetention: number;
  ownedVersions: Map<string, FakeVersionRow>;
  chunksByVersionId: Map<string, FakeChunkRow[]>;
};

let state: DbMockState;

function setupMocks(opts: { totalSizeForUser?: number } = {}) {
  state = {
    ownedBackups: new Map(),
    totalSize: opts.totalSizeForUser ?? 0,
    insertedVersion: null,
    softDeletedBeyondRetention: 0,
    ownedVersions: new Map(),
    chunksByVersionId: new Map(),
  };
  mock.module('../db', {
    namedExports: {
      getBackupOwned: async (userId: string, backupId: string) => {
        const key = `${userId}:${backupId}`;
        return state.ownedBackups.get(key) ?? null;
      },
      sumActiveStorageForUser: async (_userId: string) => state.totalSize,
      insertVersionWithChunks: async (
        params: { versionId: string; backupId: string; sizeBytes: number; manifestObjectKey: string; manifestSha256: Uint8Array; chunkCount: number },
      ) => {
        state.insertedVersion = {
          id: params.versionId,
          backup_id: params.backupId,
          created_at: new Date().toISOString(),
          size_bytes: params.sizeBytes,
          manifest_object_key: params.manifestObjectKey,
          manifest_sha256: params.manifestSha256,
          chunk_count: params.chunkCount,
          deleted_at: null,
        };
        return state.insertedVersion;
      },
      softDeleteVersionsBeyondRetention: async () => {
        state.softDeletedBeyondRetention += 1;
        return state.softDeletedBeyondRetention;
      },
      // Stubs for unrelated functions imported by storage.ts
      insertBackup: async (params: { userId: string; name: string }) => ({
        id: 'new-backup',
        user_id: params.userId,
        name: params.name,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        deleted_at: null,
      }),
      listBackupsForUser: async () => [],
      deleteBackupOwned: async () => 1,
      listVersions: async () => [],
      getVersionOwned: async (params: { userId: string; backupId: string; versionId: string }) => {
        const key = `${params.userId}:${params.backupId}:${params.versionId}`;
        return state.ownedVersions.get(key) ?? null;
      },
      listChunksForVersion: async (versionId: string) =>
        state.chunksByVersionId.get(versionId) ?? [],
      softDeleteVersionOwned: async () => 1,
    },
  });
}

afterEach(() => {
  mock.reset();
});

describe('createVersionWithUploads — input validation', () => {
  beforeEach(() => setupMocks());

  it('rejects empty chunkMetadata', async () => {
    state.ownedBackups.set('user-1:bk-1', {
      id: 'bk-1',
      user_id: 'user-1',
      name: 'Workstation',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    const { createVersionWithUploads } = await import('../storage');
    await assert.rejects(
      createVersionWithUploads({
        userId: 'user-1',
        backupId: 'bk-1',
        encryptedManifest: new Uint8Array([1, 2, 3]),
        chunkMetadata: [],
      }),
      (err: Error) =>
        (err as unknown as { code: string }).code === 'BAD_REQUEST',
    );
  });

  it('rejects malformed sha256 hex', async () => {
    state.ownedBackups.set('user-1:bk-1', {
      id: 'bk-1',
      user_id: 'user-1',
      name: 'Workstation',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    const { createVersionWithUploads } = await import('../storage');
    await assert.rejects(
      createVersionWithUploads({
        userId: 'user-1',
        backupId: 'bk-1',
        encryptedManifest: new Uint8Array([1, 2, 3]),
        chunkMetadata: [{ index: 0, encryptedSize: 100, sha256: 'too-short' }],
      }),
      (err: Error) =>
        (err as unknown as { code: string }).code === 'BAD_REQUEST',
    );
  });

  it('returns NOT_FOUND when the backup is owned by a different user', async () => {
    // Note: storage.ts treats not-found and not-owned identically (404).
    const { createVersionWithUploads } = await import('../storage');
    await assert.rejects(
      createVersionWithUploads({
        userId: 'user-A',
        backupId: 'bk-owned-by-B',
        encryptedManifest: new Uint8Array([1, 2, 3]),
        chunkMetadata: [
          { index: 0, encryptedSize: 100, sha256: 'aa'.repeat(32) },
        ],
      }),
      (err: Error) =>
        (err as unknown as { code: string }).code === 'NOT_FOUND',
    );
  });
});

describe('createVersionWithUploads — quota enforcement', () => {
  it('blocks when current + new > limit (default 1 GiB)', async () => {
    setupMocks({ totalSizeForUser: 1024 * 1024 * 1024 - 50 });
    state.ownedBackups.set('user-Q:bk-Q', {
      id: 'bk-Q',
      user_id: 'user-Q',
      name: 'big',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    const { createVersionWithUploads } = await import('../storage');
    await assert.rejects(
      createVersionWithUploads({
        userId: 'user-Q',
        backupId: 'bk-Q',
        encryptedManifest: new Uint8Array(20),
        chunkMetadata: [
          { index: 0, encryptedSize: 1000, sha256: 'aa'.repeat(32) },
        ],
      }),
      (err: Error) =>
        (err as unknown as { code: string }).code === 'STORAGE_QUOTA_EXCEEDED',
    );
  });

  it('passes when current + new < limit, and triggers retention enforcement', async () => {
    setupMocks({ totalSizeForUser: 0 });
    state.ownedBackups.set('user-R:bk-R', {
      id: 'bk-R',
      user_id: 'user-R',
      name: 'small',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      deleted_at: null,
    });
    const { createVersionWithUploads } = await import('../storage');
    const result = await createVersionWithUploads({
      userId: 'user-R',
      backupId: 'bk-R',
      encryptedManifest: new Uint8Array(20),
      chunkMetadata: [
        { index: 0, encryptedSize: 100, sha256: 'aa'.repeat(32) },
      ],
    });
    assert.equal(typeof result.versionId, 'string');
    // First entry is the manifest URL, then per-chunk URLs.
    assert.equal(result.uploadUrls.length, 2);
    assert.equal(result.uploadUrls[0].chunkIndex, -1);
    assert.equal(result.uploadUrls[1].chunkIndex, 0);
    assert.ok(state.insertedVersion);
    assert.equal(state.softDeletedBeyondRetention, 1);
  });
});

describe('getDownloadUrls — manifest sentinel + chunk lookup', () => {
  function seedVersionWithChunks(opts: {
    userId: string;
    backupId: string;
    versionId: string;
    chunkIndices: number[];
  }) {
    setupMocks();
    state.ownedVersions.set(
      `${opts.userId}:${opts.backupId}:${opts.versionId}`,
      {
        id: opts.versionId,
        backup_id: opts.backupId,
        created_at: new Date().toISOString(),
        size_bytes: 1024,
        manifest_object_key: `users/${opts.userId}/backups/${opts.backupId}/versions/${opts.versionId}/manifest`,
        manifest_sha256: new Uint8Array(32),
        chunk_count: opts.chunkIndices.length,
        deleted_at: null,
      },
    );
    state.chunksByVersionId.set(
      opts.versionId,
      opts.chunkIndices.map((i) => ({
        version_id: opts.versionId,
        chunk_index: i,
        object_key: `users/${opts.userId}/backups/${opts.backupId}/versions/${opts.versionId}/chunks/${i}`,
        size_bytes: 512,
        sha256: new Uint8Array(32),
      })),
    );
  }

  const userId = 'user-D';
  const backupId = 'bk-D';
  const versionId = 'v-D';

  it('chunkIndices [-1] returns the manifest URL', async () => {
    seedVersionWithChunks({ userId, backupId, versionId, chunkIndices: [0, 1] });
    const { getDownloadUrls } = await import('../storage');
    const urls = await getDownloadUrls({ userId, backupId, versionId, chunkIndices: [-1] });
    assert.equal(urls.length, 1);
    assert.equal(urls[0].chunkIndex, -1);
    assert.match(urls[0].presignedUrl, /^https?:\/\//);
    assert.match(urls[0].presignedUrl, /\/manifest/);
    assert.equal(typeof urls[0].expiresAt, 'string');
  });

  it('chunkIndices [-1, 0, 1] returns three URLs with the manifest first', async () => {
    seedVersionWithChunks({ userId, backupId, versionId, chunkIndices: [0, 1] });
    const { getDownloadUrls } = await import('../storage');
    const urls = await getDownloadUrls({ userId, backupId, versionId, chunkIndices: [-1, 0, 1] });
    assert.equal(urls.length, 3);
    assert.equal(urls[0].chunkIndex, -1);
    assert.match(urls[0].presignedUrl, /\/manifest/);
    assert.equal(urls[1].chunkIndex, 0);
    assert.match(urls[1].presignedUrl, /\/chunks\/0/);
    assert.equal(urls[2].chunkIndex, 1);
    assert.match(urls[2].presignedUrl, /\/chunks\/1/);
  });

  it('chunkIndices [0] returns one chunk URL with no manifest entry', async () => {
    seedVersionWithChunks({ userId, backupId, versionId, chunkIndices: [0] });
    const { getDownloadUrls } = await import('../storage');
    const urls = await getDownloadUrls({ userId, backupId, versionId, chunkIndices: [0] });
    assert.equal(urls.length, 1);
    assert.equal(urls[0].chunkIndex, 0);
    assert.match(urls[0].presignedUrl, /\/chunks\/0/);
  });

  it('chunkIndices [-2] returns NOT_FOUND (the only valid sentinel is -1)', async () => {
    seedVersionWithChunks({ userId, backupId, versionId, chunkIndices: [0] });
    const { getDownloadUrls } = await import('../storage');
    await assert.rejects(
      getDownloadUrls({ userId, backupId, versionId, chunkIndices: [-2] }),
      (err: Error) => (err as unknown as { code: string }).code === 'NOT_FOUND',
    );
  });

  it('chunkIndices [-1, 99] still rejects when chunk 99 does not exist', async () => {
    seedVersionWithChunks({ userId, backupId, versionId, chunkIndices: [0] });
    const { getDownloadUrls } = await import('../storage');
    await assert.rejects(
      getDownloadUrls({ userId, backupId, versionId, chunkIndices: [-1, 99] }),
      (err: Error) => (err as unknown as { code: string }).code === 'NOT_FOUND',
    );
  });

  it('returns NOT_FOUND when the version is owned by another user', async () => {
    setupMocks();
    // No ownedVersion entry for user-X.
    const { getDownloadUrls } = await import('../storage');
    await assert.rejects(
      getDownloadUrls({
        userId: 'user-X',
        backupId,
        versionId,
        chunkIndices: [-1],
      }),
      (err: Error) => (err as unknown as { code: string }).code === 'NOT_FOUND',
    );
  });
});
