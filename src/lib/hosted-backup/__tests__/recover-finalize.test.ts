/**
 * Tests for POST /api/auth/recover/finalize. Contract §6.
 *
 * Covers the v2.0 wire format: recoveryToken arrives as Authorization: Bearer
 * (not in body); the body contains only new passphrase-derived material;
 * a successful finalize burns the token (replays return RECOVERY_TOKEN_EXPIRED).
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = '7e'.repeat(32);
const FIXED_KID = 'hb-test-kid-recover-finalize';

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

type CapturedFinalize = {
  jti: string;
  userId: string;
  clientSalt: Uint8Array;
  wrappedDek: Uint8Array;
  serverPasswordHash: string;
};

let lastCapturedFinalize: CapturedFinalize | null = null;

async function setupMocks() {
  // Each test gets a fresh used-jti set so the replay test isn't
  // contaminated by neighbours running in parallel.
  const usedJtis = new Set<string>();
  lastCapturedFinalize = null;

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
      recoverFinalizeAtomic: async (params: CapturedFinalize) => {
        if (usedJtis.has(params.jti)) return { tokenAlreadyUsed: true };
        usedJtis.add(params.jti);
        lastCapturedFinalize = params;
        return { tokenAlreadyUsed: false };
      },
      getSubscriptionStatus: async () => 'active' as const,
      insertRefreshToken: async () => ({
        id: 'rt-1',
        user_id: 'u-1',
        chain_id: 'c-1',
        parent_id: null,
        token_hash: new Uint8Array(32),
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        revoked_at: null,
      }),
    },
  });
}

afterEach(() => {
  mock.reset();
});

const VALID_BODY = {
  newServerPassword: Buffer.alloc(32, 0x42).toString('base64'),
  newSalt: Buffer.alloc(16, 0x11).toString('base64'),
  newKdfParams: { algorithm: 'argon2id', memory: 65536, iterations: 3, parallelism: 4 },
  newWrappedDEK: Buffer.alloc(60, 0x55).toString('base64'),
};

function makeFinalizeRequest(opts: {
  authorizationHeader?: string;
  body?: unknown;
}): import('next/server').NextRequest {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (opts.authorizationHeader !== undefined) {
    headers.set('authorization', opts.authorizationHeader);
  }
  return new Request('https://test.local/api/auth/recover/finalize', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? VALID_BODY),
  }) as unknown as import('next/server').NextRequest;
}

async function mintTestRecoveryToken(userId = 'u-1') {
  const { mintRecoveryToken } = await import('../jwt');
  return mintRecoveryToken({ userId });
}

describe('recover/finalize — Authorization: Bearer required', () => {
  it('rejects request with no Authorization header', async () => {
    await setupMocks();
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const res = await POST(makeFinalizeRequest({}));
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'UNAUTHENTICATED');
  });

  it('rejects non-Bearer scheme', async () => {
    await setupMocks();
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const res = await POST(
      makeFinalizeRequest({ authorizationHeader: 'Basic abc123' }),
    );
    assert.equal(res.status, 401);
  });

  it('rejects empty Bearer token', async () => {
    await setupMocks();
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const res = await POST(
      makeFinalizeRequest({ authorizationHeader: 'Bearer  ' }),
    );
    assert.equal(res.status, 401);
  });

  it('rejects malformed bearer token with RECOVERY_TOKEN_EXPIRED', async () => {
    await setupMocks();
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const res = await POST(
      makeFinalizeRequest({ authorizationHeader: 'Bearer not.a.real.token' }),
    );
    assert.equal(res.status, 401);
    const body = (await res.json()) as { error: { code: string } };
    // Contract §6: any unusable recovery token collapses to one code so
    // engine/GUI can show one "session over, start again" UX state.
    assert.equal(body.error.code, 'RECOVERY_TOKEN_EXPIRED');
  });
});

describe('recover/finalize — happy path', () => {
  it('valid bearer + body → 200 with userId, accessToken, refreshToken, subscriptionStatus', async () => {
    await setupMocks();
    const { token } = await mintTestRecoveryToken('u-success-1');
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const res = await POST(
      makeFinalizeRequest({ authorizationHeader: `Bearer ${token}` }),
    );
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      userId: string;
      accessToken: string;
      refreshToken: string;
      subscriptionStatus: string;
    };
    assert.equal(body.userId, 'u-success-1');
    assert.equal(typeof body.accessToken, 'string');
    assert.ok(body.accessToken.length > 0);
    assert.equal(typeof body.refreshToken, 'string');
    assert.equal(body.subscriptionStatus, 'active');
    assert.equal(
      res.headers.get('X-Endstate-API-Version'),
      '2.0',
      'response must stamp the new contract version',
    );

    // Atomic finalize must have received the body's new credential material.
    assert.ok(lastCapturedFinalize, 'recoverFinalizeAtomic must have been called');
    assert.equal(lastCapturedFinalize.userId, 'u-success-1');
    assert.equal(lastCapturedFinalize.clientSalt.length, 16);
    assert.ok(
      lastCapturedFinalize.serverPasswordHash.startsWith('$argon2id$'),
      'serverPasswordHash should be argon2id PHC string',
    );
  });
});

describe('recover/finalize — replay protection', () => {
  it('replaying the same token returns RECOVERY_TOKEN_EXPIRED', async () => {
    await setupMocks();
    const { token } = await mintTestRecoveryToken('u-replay-1');
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');

    const first = await POST(
      makeFinalizeRequest({ authorizationHeader: `Bearer ${token}` }),
    );
    assert.equal(first.status, 200);

    const second = await POST(
      makeFinalizeRequest({ authorizationHeader: `Bearer ${token}` }),
    );
    assert.equal(second.status, 401);
    const body = (await second.json()) as { error: { code: string } };
    assert.equal(body.error.code, 'RECOVERY_TOKEN_EXPIRED');
  });
});

describe('recover/finalize — body validation', () => {
  it('rejects missing newServerPassword', async () => {
    await setupMocks();
    const { token } = await mintTestRecoveryToken('u-body-1');
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const { newServerPassword: _drop, ...rest } = VALID_BODY;
    const res = await POST(
      makeFinalizeRequest({
        authorizationHeader: `Bearer ${token}`,
        body: rest,
      }),
    );
    assert.equal(res.status, 400);
  });

  it('rejects wrong-length salt', async () => {
    await setupMocks();
    const { token } = await mintTestRecoveryToken('u-body-2');
    const { POST } = await import('../../../app/api/auth/recover/finalize/route');
    const res = await POST(
      makeFinalizeRequest({
        authorizationHeader: `Bearer ${token}`,
        body: { ...VALID_BODY, newSalt: Buffer.alloc(8).toString('base64') },
      }),
    );
    assert.equal(res.status, 400);
  });
});
