import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  issueFreshChain,
  rotateRefreshToken,
  revokeRefreshTokenByValue,
  __setStore,
} from '../refresh';
import type { RefreshTokenRow } from '../db';

type Row = RefreshTokenRow;

function makeInMemoryStore() {
  const rows = new Map<string, Row>();
  const byHashKey = (h: Uint8Array) => Buffer.from(h).toString('hex');

  return {
    rows,
    store: {
      insertRefreshToken: async (params: {
        userId: string;
        chainId: string;
        parentId: string | null;
        tokenHash: Uint8Array;
        expiresAt: Date;
      }): Promise<Row> => {
        const id = randomUUID();
        const row: Row = {
          id,
          user_id: params.userId,
          chain_id: params.chainId,
          parent_id: params.parentId,
          token_hash: params.tokenHash,
          issued_at: new Date().toISOString(),
          expires_at: params.expiresAt.toISOString(),
          revoked_at: null,
        };
        rows.set(byHashKey(params.tokenHash), row);
        return row;
      },
      findRefreshTokenByHash: async (
        tokenHash: Uint8Array,
      ): Promise<Row | null> => {
        return rows.get(byHashKey(tokenHash)) ?? null;
      },
      getChainRoot: async (chainId: string): Promise<Row | null> => {
        for (const row of rows.values()) {
          if (row.chain_id === chainId && row.parent_id === null) return row;
        }
        return null;
      },
      revokeRefreshToken: async (id: string): Promise<void> => {
        for (const row of rows.values()) {
          if (row.id === id && row.revoked_at === null) {
            row.revoked_at = new Date().toISOString();
          }
        }
      },
      revokeRefreshChain: async (chainId: string): Promise<void> => {
        for (const row of rows.values()) {
          if (row.chain_id === chainId && row.revoked_at === null) {
            row.revoked_at = new Date().toISOString();
          }
        }
      },
    },
  };
}

afterEach(() => {
  __setStore(null);
});

describe('refresh-token rotation', () => {
  it('issues a fresh chain root and rotates successfully', async () => {
    const { store, rows } = makeInMemoryStore();
    __setStore(store);
    const initial = await issueFreshChain('user-1');
    assert.equal(typeof initial.token, 'string');
    assert.ok(initial.token.length > 30);
    assert.equal(initial.row.parent_id, null);
    const chainId = initial.row.chain_id;

    const rotated = await rotateRefreshToken(initial.token);
    assert.equal(rotated.row.chain_id, chainId);
    assert.equal(rotated.row.parent_id, initial.row.id);
    assert.notEqual(rotated.token, initial.token);

    // The first token is now revoked
    let firstRow: Row | undefined;
    for (const row of rows.values()) {
      if (row.id === initial.row.id) firstRow = row;
    }
    assert.ok(firstRow);
    assert.notEqual(firstRow!.revoked_at, null);
  });

  it('revokes the entire chain on token reuse', async () => {
    const { store, rows } = makeInMemoryStore();
    __setStore(store);
    const initial = await issueFreshChain('user-2');
    const child1 = await rotateRefreshToken(initial.token);
    // Pretend an attacker presents the already-revoked initial token
    await assert.rejects(
      rotateRefreshToken(initial.token),
      (err: Error) =>
        String((err as { code: string }).code) === 'REFRESH_REUSE_DETECTED',
    );
    // Every row in the chain should now be revoked
    for (const row of rows.values()) {
      if (row.chain_id === initial.row.chain_id) {
        assert.notEqual(
          row.revoked_at,
          null,
          `row ${row.id} should be revoked`,
        );
      }
    }
    // Even the legitimate child token cannot be rotated anymore
    await assert.rejects(
      rotateRefreshToken(child1.token),
      (err: Error) =>
        String((err as { code: string }).code) === 'REFRESH_REUSE_DETECTED',
    );
  });

  it('rejects an unknown token', async () => {
    const { store } = makeInMemoryStore();
    __setStore(store);
    await assert.rejects(
      rotateRefreshToken('not-a-real-token'),
      (err: Error) =>
        String((err as { code: string }).code) === 'REFRESH_INVALID',
    );
  });

  it('refuses chains older than 30 days', async () => {
    const { store, rows } = makeInMemoryStore();
    __setStore(store);
    const issued = await issueFreshChain('user-3');
    // Backdate the chain root so its issued_at is 31 days ago
    for (const row of rows.values()) {
      if (row.id === issued.row.id) {
        row.issued_at = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      }
    }
    await assert.rejects(
      rotateRefreshToken(issued.token),
      (err: Error) =>
        String((err as { code: string }).code) === 'REFRESH_EXPIRED',
    );
  });

  it('logout revokes a token idempotently', async () => {
    const { store, rows } = makeInMemoryStore();
    __setStore(store);
    const issued = await issueFreshChain('user-4');
    await revokeRefreshTokenByValue(issued.token);
    let rev1: Row | undefined;
    for (const row of rows.values()) {
      if (row.id === issued.row.id) rev1 = row;
    }
    assert.ok(rev1);
    assert.notEqual(rev1!.revoked_at, null);
    const firstRevokeAt = rev1!.revoked_at;
    // Calling again is a no-op (no throw), revoke timestamp preserved
    await revokeRefreshTokenByValue(issued.token);
    let rev2: Row | undefined;
    for (const row of rows.values()) {
      if (row.id === issued.row.id) rev2 = row;
    }
    assert.equal(rev2!.revoked_at, firstRevokeAt);
  });
});
