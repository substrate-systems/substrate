/**
 * Tests for POST /api/auth/claim — the endpoint anonymous-buyer pre-accounts
 * call from the GUI's first-launch credential setup. Validates bearer
 * extraction, the four claim-token verdicts, credential validation, and
 * JWT issuance.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = 'a1'.repeat(32);
const FIXED_KID = 'hb-test-kid-claim-route';

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

type State = {
  verifyResult: 'valid' | 'invalid' | 'expired' | 'consumed';
  consumeResult: 'consumed' | 'race' | 'invalid' | 'expired';
  insertedCreds: Array<{ userId: string }>;
  refreshIssued: number;
  subscriptionStatus: string;
  insertAuthShouldUniqueViolate: boolean;
};

let state: State;

function setupMocks(opts: Partial<State> = {}) {
  state = {
    verifyResult: opts.verifyResult ?? 'valid',
    consumeResult: opts.consumeResult ?? 'consumed',
    insertedCreds: [],
    refreshIssued: 0,
    subscriptionStatus: opts.subscriptionStatus ?? 'active',
    insertAuthShouldUniqueViolate: opts.insertAuthShouldUniqueViolate ?? false,
  };

  mock.module('../claim-tokens', {
    namedExports: {
      verifyClaimToken: async (_token: string) => {
        switch (state.verifyResult) {
          case 'invalid':
            return { kind: 'invalid' as const };
          case 'expired':
            return { kind: 'expired' as const, row: stubRow() };
          case 'consumed':
            return { kind: 'consumed' as const, row: stubRow() };
          case 'valid':
            return { kind: 'valid' as const, row: stubRow() };
        }
      },
      consumeClaimToken: async (_token: string) => {
        switch (state.consumeResult) {
          case 'invalid':
            return { kind: 'invalid' as const };
          case 'expired':
            return { kind: 'expired' as const };
          case 'race':
            return { kind: 'race' as const };
          case 'consumed':
            return {
              kind: 'consumed' as const,
              userId: 'u-claim-1',
              email: 'claimed@example.com',
            };
        }
      },
    },
  });

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
      insertAuthCredentials: async (p: { userId: string }) => {
        if (state.insertAuthShouldUniqueViolate) {
          const e = new Error('duplicate key') as Error & { code: string };
          e.code = '23505';
          throw e;
        }
        state.insertedCreds.push({ userId: p.userId });
      },
      getSubscriptionStatus: async (_userId: string) => state.subscriptionStatus,
      insertRefreshToken: async () => {
        state.refreshIssued += 1;
        return {
          id: 'r-1',
          user_id: 'u-claim-1',
          chain_id: 'c-1',
          parent_id: null,
          token_hash: new Uint8Array(32),
          issued_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          revoked_at: null,
        };
      },
    },
  });
}

function stubRow() {
  return {
    token_hash: new Uint8Array(32),
    user_id: 'u-claim-1',
    email: 'claimed@example.com',
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    consumed_at: null,
    resend_count: 0,
    last_sent_at: new Date().toISOString(),
    founder_alerted_at: null,
  };
}

function validCredentialBody(): Record<string, string> {
  return {
    serverPassword: Buffer.alloc(32, 0x11).toString('base64'),
    salt: Buffer.alloc(16, 0x22).toString('base64'),
    kdfParams: JSON.stringify({
      algorithm: 'argon2id',
      memory: 65536,
      iterations: 3,
      parallelism: 4,
    }),
    wrappedDEK: Buffer.alloc(60, 0x33).toString('base64'),
    recoveryKeyVerifier: Buffer.alloc(32, 0x44).toString('base64'),
    recoveryKeyWrappedDEK: Buffer.alloc(60, 0x55).toString('base64'),
  };
}

function makeReq(token: string | null, bodyOverride?: object): Request {
  const headers = new Headers({ 'content-type': 'application/json' });
  if (token) headers.set('authorization', `Bearer ${token}`);
  // The route expects kdfParams as a real object, not a JSON string —
  // validCredentialBody stringifies it for clarity. Reparse here.
  const cred = validCredentialBody();
  const body =
    bodyOverride !== undefined
      ? bodyOverride
      : {
          serverPassword: cred.serverPassword,
          salt: cred.salt,
          kdfParams: JSON.parse(cred.kdfParams),
          wrappedDEK: cred.wrappedDEK,
          recoveryKeyVerifier: cred.recoveryKeyVerifier,
          recoveryKeyWrappedDEK: cred.recoveryKeyWrappedDEK,
        };
  return new Request('https://test.local/api/auth/claim', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

afterEach(() => mock.reset());

describe('POST /api/auth/claim', () => {
  it('returns 401 UNAUTHENTICATED without bearer', async () => {
    setupMocks();
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq(null) as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 401);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'UNAUTHENTICATED');
  });

  it('returns 401 CLAIM_TOKEN_INVALID when token verification rejects', async () => {
    setupMocks({ verifyResult: 'invalid' });
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq('bogus-token') as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 401);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'CLAIM_TOKEN_INVALID');
  });

  it('returns 401 CLAIM_TOKEN_EXPIRED when token is past expiry', async () => {
    setupMocks({ verifyResult: 'expired' });
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq('stale-token') as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 401);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'CLAIM_TOKEN_EXPIRED');
  });

  it('returns 409 CLAIM_TOKEN_CONSUMED when token is already used', async () => {
    setupMocks({ verifyResult: 'consumed' });
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq('used-token') as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 409);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'CLAIM_TOKEN_CONSUMED');
  });

  it('returns 400 BAD_REQUEST when serverPassword is too short', async () => {
    setupMocks();
    const { POST } = await import('../../../app/api/auth/claim/route');
    // Otherwise-valid body, just a short serverPassword. The route validates
    // serverPassword length (32 bytes) and throws BAD_REQUEST before
    // validateKdfParams or anything else.
    const cred = validCredentialBody();
    const res = await POST(
      makeReq('valid-token', {
        serverPassword: Buffer.alloc(8).toString('base64'),
        salt: cred.salt,
        kdfParams: JSON.parse(cred.kdfParams),
        wrappedDEK: cred.wrappedDEK,
        recoveryKeyVerifier: cred.recoveryKeyVerifier,
        recoveryKeyWrappedDEK: cred.recoveryKeyWrappedDEK,
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 400);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'BAD_REQUEST');
  });

  it('happy path consumes token, inserts creds, returns JWTs', async () => {
    setupMocks();
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq('valid-token') as unknown as import('next/server').NextRequest);
    const text = await res.text();
    assert.equal(res.status, 200, text);
    const j = JSON.parse(text) as {
      userId: string;
      email: string;
      accessToken: string;
      refreshToken: string;
      subscriptionStatus: string;
    };
    assert.equal(j.userId, 'u-claim-1');
    assert.equal(j.email, 'claimed@example.com');
    assert.ok(j.accessToken.length > 0);
    assert.ok(j.refreshToken.length > 0);
    assert.equal(j.subscriptionStatus, 'active');
    assert.equal(state.insertedCreds.length, 1);
    assert.equal(state.refreshIssued, 1);
  });

  it('returns 409 CLAIM_TOKEN_CONSUMED on a consume race (lost the update)', async () => {
    setupMocks({ consumeResult: 'race' });
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq('racy-token') as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 409);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'CLAIM_TOKEN_CONSUMED');
    assert.equal(state.insertedCreds.length, 0);
  });

  it('returns 409 CLAIM_TOKEN_CONSUMED when auth_credentials already exist', async () => {
    setupMocks({ insertAuthShouldUniqueViolate: true });
    const { POST } = await import('../../../app/api/auth/claim/route');
    const res = await POST(makeReq('valid-token') as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 409);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'CLAIM_TOKEN_CONSUMED');
  });
});
