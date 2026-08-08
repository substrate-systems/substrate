/**
 * Route surface of the two-phase version commit (contract §7):
 *
 *  - `POST /api/backups/:id/versions` reads the caller's schema from the
 *    request-side `X-Endstate-API-Version` header and forwards the decision.
 *  - `POST /api/backups/:id/versions/:vid/commit` is write-gated, idempotent,
 *    and returns the standard error envelope — including the 404 that a
 *    cross-user attempt gets, matching every sibling `/api/backups/*` route.
 *
 * Auth + storage are module-mocked per the sibling `[backupId]/__tests__`
 * route test; the storage behaviour itself is covered in
 * `version-commit.test.ts` and against real Postgres in
 * `version-commit-postgres.integration.test.ts`.
 */

import { before, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { errors } from '@/lib/hosted-backup/errors';

type CommitResult = {
  versionId: string;
  committedAt: string;
  alreadyCommitted: boolean;
  prunedVersions: number;
};

const state = {
  writeAccessError: null as Error | null,
  commitArgs: null as unknown,
  commitImpl: async (): Promise<CommitResult> => ({
    versionId: 'v-1',
    committedAt: '2026-06-05T12:00:00Z',
    alreadyCommitted: false,
    prunedVersions: 1,
  }),
  createArgs: null as { requiresCommit?: boolean } | null,
};

before(() => {
  mock.module('@/lib/hosted-backup/auth-middleware', {
    namedExports: {
      requireWriteAccess: async () => {
        if (state.writeAccessError) throw state.writeAccessError;
        return { userId: 'user-1', subscriptionStatus: 'active', jti: 'j' };
      },
      requireReadAccess: async () => ({
        userId: 'user-1',
        subscriptionStatus: 'active',
        jti: 'j',
      }),
    },
  });
  mock.module('@/lib/hosted-backup/storage', {
    namedExports: {
      commitVersionUpload: async (p: unknown) => {
        state.commitArgs = p;
        return state.commitImpl();
      },
      createVersionWithUploads: async (p: { requiresCommit?: boolean }) => {
        state.createArgs = p;
        return {
          versionId: 'v-created',
          uploadUrls: [{ chunkIndex: -1, presignedUrl: 'https://r2/x', expiresAt: 'later' }],
          requiresCommit: p.requiresCommit === true,
        };
      },
      listVersionsOwned: async () => [],
    },
  });
});

beforeEach(() => {
  state.writeAccessError = null;
  state.commitArgs = null;
  state.createArgs = null;
  state.commitImpl = async () => ({
    versionId: 'v-1',
    committedAt: '2026-06-05T12:00:00Z',
    alreadyCommitted: false,
    prunedVersions: 1,
  });
});

async function callCommit(backupId = 'b-1', versionId = 'v-1') {
  const { POST } = await import(
    '../../../app/api/backups/[backupId]/versions/[versionId]/commit/route'
  );
  const req = new Request(
    `http://localhost/api/backups/${backupId}/versions/${versionId}/commit`,
    { method: 'POST' },
  );
  const res = await POST(req as never, {
    params: Promise.resolve({ backupId, versionId }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

async function callCreateVersion(headers: Record<string, string>) {
  const { POST } = await import('../../../app/api/backups/[backupId]/versions/route');
  const req = new Request('http://localhost/api/backups/b-1/versions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({
      encryptedManifest: Buffer.from('manifest').toString('base64'),
      chunkMetadata: [{ index: 0, encryptedSize: 10, sha256: 'aa'.repeat(32) }],
    }),
  });
  const res = await POST(req as never, { params: Promise.resolve({ backupId: 'b-1' }) });
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body };
}

describe('POST /api/backups/:id/versions/:vid/commit', () => {
  it('commits: 200 with the versionId and commit timestamp', async () => {
    const { res, body } = await callCommit();
    assert.equal(res.status, 200);
    assert.equal(body.versionId, 'v-1');
    assert.equal(body.committedAt, '2026-06-05T12:00:00Z');
    assert.equal(body.alreadyCommitted, false);
    assert.deepEqual(state.commitArgs, {
      userId: 'user-1',
      backupId: 'b-1',
      versionId: 'v-1',
    });
  });

  it('stamps the API version header like every other hosted-backup route', async () => {
    const { res } = await callCommit();
    assert.equal(res.headers.get('X-Endstate-API-Version'), '2.1');
  });

  it('is idempotent at the wire level: a replay is 200 with alreadyCommitted', async () => {
    state.commitImpl = async () => ({
      versionId: 'v-1',
      committedAt: '2026-06-05T12:00:00Z',
      alreadyCommitted: true,
      prunedVersions: 0,
    });
    const { res, body } = await callCommit();
    assert.equal(res.status, 200, 'a replay is success, not a conflict');
    assert.equal(body.alreadyCommitted, true);
  });

  it('maps a cross-user / unknown version to 404 with the error envelope', async () => {
    state.commitImpl = async () => {
      throw errors.notFound('version not found');
    };
    const { res, body } = await callCommit('b-other', 'v-other');
    assert.equal(res.status, 404);
    assert.equal(body.success, false);
    assert.equal((body.error as { code: string }).code, 'NOT_FOUND');
  });

  it('is write-gated: a lapsed subscription cannot publish a version', async () => {
    state.writeAccessError = errors.subscriptionRequired('an active subscription is required');
    const { res, body } = await callCommit();
    assert.equal(res.status, (errors.subscriptionRequired('x') as { status: number }).status);
    assert.equal(body.success, false);
    assert.equal(state.commitArgs, null, 'storage is never reached');
  });
});

describe('POST /api/backups/:id/versions — schema negotiation', () => {
  it('a 2.1 client is told it must commit', async () => {
    const { res, body } = await callCreateVersion({ 'x-endstate-api-version': '2.1' });
    assert.equal(res.status, 200);
    assert.equal(state.createArgs?.requiresCommit, true);
    assert.equal(body.requiresCommit, true);
  });

  it('a 2.0 client keeps the single-phase behaviour', async () => {
    const { body } = await callCreateVersion({ 'x-endstate-api-version': '2.0' });
    assert.equal(state.createArgs?.requiresCommit, false);
    assert.equal(body.requiresCommit, false);
  });

  it('a client that sends no version header keeps the single-phase behaviour', async () => {
    const { body } = await callCreateVersion({});
    assert.equal(state.createArgs?.requiresCommit, false);
    assert.equal(body.requiresCommit, false);
  });
});
