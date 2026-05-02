/**
 * Subscription gating tests for requireWriteAccess / requireReadAccess.
 * These exercise the middleware's "re-read DB, ignore JWT claim" behavior
 * per contract §10.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = '7e'.repeat(32);
const FIXED_KID = 'hb-test-kid-gating';

before(() => {
  process.env.ENDSTATE_JWT_PRIVATE_KEY_HEX = FIXED_SEED_HEX;
  process.env.ENDSTATE_JWT_ACTIVE_KID = FIXED_KID;
  process.env.ENDSTATE_OIDC_ISSUER_URL = 'https://test.substratesystems.io';
});

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

let mockedDbStatus: 'none' | 'active' | 'grace' | 'cancelled' = 'none';

async function setupMocks() {
  mock.module('../db', {
    namedExports: {
      getActiveAndRecentlyRetiredSigningKeys: async () => {
        const { publicKey } = await ed.keygenAsync(bytesFromHex(FIXED_SEED_HEX));
        return [
          {
            kid: FIXED_KID,
            public_key: publicKey,
            algorithm: 'EdDSA',
            created_at: new Date().toISOString(),
            retired_at: null,
          },
        ];
      },
      getSubscriptionStatus: async () => mockedDbStatus,
    },
  });
}

function makeReqWithBearer(token: string): import('next/server').NextRequest {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  // The middleware only reads the auth header; a Request shape is enough.
  return new Request('https://test.local/api/whatever', { headers }) as unknown as import('next/server').NextRequest;
}

afterEach(() => mock.reset());

describe('requireWriteAccess', () => {
  it('allows when DB status is active', async () => {
    await setupMocks();
    mockedDbStatus = 'active';
    const { mintAccessToken } = await import('../jwt');
    const { requireWriteAccess } = await import('../auth-middleware');
    const { token } = await mintAccessToken({
      userId: 'u-1',
      subscriptionStatus: 'active',
    });
    const ctx = await requireWriteAccess(makeReqWithBearer(token));
    assert.equal(ctx.subscriptionStatus, 'active');
  });

  for (const status of ['none', 'grace', 'cancelled'] as const) {
    it(`blocks when DB status is ${status}`, async () => {
      await setupMocks();
      mockedDbStatus = status;
      const { mintAccessToken } = await import('../jwt');
      const { requireWriteAccess } = await import('../auth-middleware');
      const { token } = await mintAccessToken({
        userId: 'u-2',
        subscriptionStatus: 'active', // JWT claim says active — DB says otherwise
      });
      await assert.rejects(
        requireWriteAccess(makeReqWithBearer(token)),
        (err: Error) =>
          (err as unknown as { code: string }).code === 'SUBSCRIPTION_REQUIRED',
      );
    });
  }
});

describe('requireReadAccess', () => {
  for (const status of ['active', 'grace', 'cancelled'] as const) {
    it(`allows when DB status is ${status}`, async () => {
      await setupMocks();
      mockedDbStatus = status;
      const { mintAccessToken } = await import('../jwt');
      const { requireReadAccess } = await import('../auth-middleware');
      const { token } = await mintAccessToken({
        userId: 'u-3',
        subscriptionStatus: status,
      });
      const ctx = await requireReadAccess(makeReqWithBearer(token));
      assert.equal(ctx.subscriptionStatus, status);
    });
  }

  it('blocks when DB status is none', async () => {
    await setupMocks();
    mockedDbStatus = 'none';
    const { mintAccessToken } = await import('../jwt');
    const { requireReadAccess } = await import('../auth-middleware');
    const { token } = await mintAccessToken({
      userId: 'u-4',
      subscriptionStatus: 'active',
    });
    await assert.rejects(
      requireReadAccess(makeReqWithBearer(token)),
      (err: Error) =>
        (err as unknown as { code: string }).code === 'SUBSCRIPTION_REQUIRED',
    );
  });
});
