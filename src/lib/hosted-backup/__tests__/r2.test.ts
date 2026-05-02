import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  process.env.R2_ENDPOINT = 'https://test-account.r2.cloudflarestorage.com';
  process.env.R2_ACCESS_KEY_ID = 'AKIATESTKEY1234567890';
  process.env.R2_SECRET_ACCESS_KEY = 'secret-test-key-very-long-string';
  process.env.R2_BUCKET = 'endstate-backups-test';
});

describe('R2 object key helpers', () => {
  it('manifestKey scopes by user, backup, and version', async () => {
    const { manifestKey } = await import('../r2');
    const key = manifestKey({
      userId: 'user-1',
      backupId: 'bk-2',
      versionId: 'v-3',
    });
    assert.equal(key, 'users/user-1/backups/bk-2/versions/v-3/manifest');
  });

  it('chunkKey scopes by user, backup, version, and chunk index', async () => {
    const { chunkKey } = await import('../r2');
    const key = chunkKey({
      userId: 'user-1',
      backupId: 'bk-2',
      versionId: 'v-3',
      chunkIndex: 7,
    });
    assert.equal(key, 'users/user-1/backups/bk-2/versions/v-3/chunks/7');
  });

  it('userPrefix is users/<id>/', async () => {
    const { userPrefix } = await import('../r2');
    assert.equal(userPrefix('abc'), 'users/abc/');
  });
});

describe('presigned URL TTL', () => {
  it('presignPut produces a URL whose expiresAt is ~5 minutes from now', async () => {
    const { presignPut } = await import('../r2');
    const before = Date.now();
    const signed = await presignPut('users/u/backups/b/versions/v/chunks/0');
    const after = Date.now();
    assert.ok(signed.url.startsWith('https://'));
    assert.ok(signed.url.includes('test-account.r2.cloudflarestorage.com'));
    const ttlMs = signed.expiresAt.getTime() - before;
    // Should be close to 300000ms (5 min). Allow generous slack.
    assert.ok(
      ttlMs >= 300_000 - 100 && ttlMs <= 300_000 + (after - before) + 100,
      `expiresAt should be ~300s out, was ${ttlMs}ms`,
    );
    // The signed URL embeds the configured TTL.
    assert.ok(
      signed.url.includes('X-Amz-Expires=300') ||
        signed.url.includes('x-amz-expires=300'),
      'signed URL should embed X-Amz-Expires=300',
    );
  });

  it('presignGet produces a URL scoped to the requested key', async () => {
    const { presignGet } = await import('../r2');
    const signed = await presignGet('users/u/backups/b/versions/v/manifest');
    assert.ok(signed.url.includes('users/u/backups/b/versions/v/manifest'));
    assert.ok(
      signed.url.includes('X-Amz-Expires=300') ||
        signed.url.includes('x-amz-expires=300'),
    );
  });
});
