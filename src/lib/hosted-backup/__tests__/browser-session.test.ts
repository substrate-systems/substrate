/**
 * Unit tests for the /account portal handoff lib. Validates:
 *
 * - the new 60s/aud:endstate-account JWT shape from `mintBrowserSessionToken`
 * - `verifyBrowserSessionToken` accepts that token and rejects access tokens
 * - `redeemBrowserSession` end-to-end: validate → burn jti → cookie session
 * - replay attempts (same jti) return BROWSER_SESSION_CONSUMED
 * - `resolveAccountSession` / `invalidateAccountSession` round-trip
 *
 * The DB layer is monkey-patched via in-memory Maps so these tests don't
 * require a live Neon connection. The JWT layer uses the same fixed-keypair
 * test seam as the existing jwt.test.ts.
 */

import { before, after, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = 'a3'.repeat(32);
const FIXED_KID = 'hb-account-test-kid';

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// --- Shared state for the in-memory DB ---
const accountSessions = new Map<
  string,
  { userId: string; expiresAt: Date }
>();
const burnedJtis = new Set<string>();

before(async () => {
  process.env.ENDSTATE_JWT_PRIVATE_KEY_HEX = FIXED_SEED_HEX;
  process.env.ENDSTATE_JWT_ACTIVE_KID = FIXED_KID;
  process.env.ENDSTATE_OIDC_ISSUER_URL = 'https://test.substratesystems.io';
  delete process.env.ENDSTATE_ACCOUNT_PORTAL_URL;

  const { __setKeysProvider } = await import('../jwt');
  const { publicKey } = await ed.keygenAsync(bytesFromHex(FIXED_SEED_HEX));
  __setKeysProvider(async () => [
    {
      kid: FIXED_KID,
      public_key: publicKey,
      algorithm: 'EdDSA',
      created_at: new Date().toISOString(),
      retired_at: null,
    },
  ]);

  // Mock the DB layer the lib imports. Node's experimental module-mocks
  // (enabled in `npm test` via `--experimental-test-module-mocks`) lets us
  // replace the named exports the browser-session lib pulls from `../db`
  // with fakes backed by in-memory Maps.
  mock.module('../db', {
    namedExports: {
      insertAccountSession: async (params: {
        sessionId: string;
        userId: string;
        expiresAt: Date;
      }) => {
        accountSessions.set(params.sessionId, {
          userId: params.userId,
          expiresAt: params.expiresAt,
        });
      },
      findAccountSession: async (sessionId: string) => {
        const row = accountSessions.get(sessionId);
        if (!row) return null;
        if (row.expiresAt.getTime() <= Date.now()) return null;
        return {
          userId: row.userId,
          expiresAt: row.expiresAt.toISOString(),
        };
      },
      deleteAccountSession: async (sessionId: string) => {
        accountSessions.delete(sessionId);
      },
      burnBrowserSessionJti: async (jti: string) => {
        if (burnedJtis.has(jti)) return false;
        burnedJtis.add(jti);
        return true;
      },
    },
  });
});

after(async () => {
  const { __setKeysProvider } = await import('../jwt');
  __setKeysProvider(null);
});

beforeEach(() => {
  accountSessions.clear();
  burnedJtis.clear();
});

function decodeJwtPayload<T>(token: string): T {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

function decodeJwtHeader<T>(token: string): T {
  const part = token.split('.')[0];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

describe('mintBrowserSessionToken', () => {
  it('produces a JWT with aud=endstate-account and 60s TTL', async () => {
    const { mintBrowserSessionToken } = await import('../jwt');
    const { token, jti, exp } = await mintBrowserSessionToken({
      userId: '00000000-0000-0000-0000-000000000007',
    });
    const claims = decodeJwtPayload<{
      iss: string;
      sub: string;
      aud: string;
      iat: number;
      exp: number;
      nbf: number;
      jti: string;
    }>(token);
    assert.equal(claims.iss, 'https://test.substratesystems.io');
    assert.equal(claims.aud, 'endstate-account');
    assert.equal(claims.sub, '00000000-0000-0000-0000-000000000007');
    assert.equal(claims.exp - claims.iat, 60);
    assert.equal(claims.nbf, claims.iat);
    assert.equal(claims.jti, jti);
    assert.equal(exp, claims.exp);
  });

  it('uses the same EdDSA kid as the access token mint', async () => {
    const { mintBrowserSessionToken } = await import('../jwt');
    const { token } = await mintBrowserSessionToken({
      userId: '00000000-0000-0000-0000-000000000007',
    });
    const header = decodeJwtHeader<{ alg: string; typ: string; kid: string }>(
      token,
    );
    assert.equal(header.alg, 'EdDSA');
    assert.equal(header.typ, 'JWT');
    assert.equal(header.kid, FIXED_KID);
  });
});

describe('verifyBrowserSessionToken', () => {
  it('rejects an access token (wrong audience)', async () => {
    const { mintAccessToken, verifyBrowserSessionToken } = await import(
      '../jwt'
    );
    const { token } = await mintAccessToken({
      userId: '00000000-0000-0000-0000-000000000007',
      subscriptionStatus: 'active',
    });
    await assert.rejects(
      () => verifyBrowserSessionToken(token),
      /wrong audience/,
    );
  });

  it('accepts a freshly minted browser-session token', async () => {
    const { mintBrowserSessionToken, verifyBrowserSessionToken } = await import(
      '../jwt'
    );
    const { token, jti } = await mintBrowserSessionToken({
      userId: '00000000-0000-0000-0000-000000000007',
    });
    const result = await verifyBrowserSessionToken(token);
    assert.equal(result.userId, '00000000-0000-0000-0000-000000000007');
    assert.equal(result.jti, jti);
  });
});

describe('mintBrowserSession (lib)', () => {
  it('defaults accountUrl to {issuer}/account/start', async () => {
    const { mintBrowserSession } = await import('../browser-session');
    const { sessionToken, accountUrl } = await mintBrowserSession(
      '00000000-0000-0000-0000-000000000007',
    );
    assert.equal(
      accountUrl,
      'https://test.substratesystems.io/account/start',
    );
    assert.ok(sessionToken.split('.').length === 3, 'looks like a JWT');
  });

  it('honors ENDSTATE_ACCOUNT_PORTAL_URL override', async () => {
    process.env.ENDSTATE_ACCOUNT_PORTAL_URL = 'https://self.example/portal';
    try {
      const { mintBrowserSession } = await import('../browser-session');
      const { accountUrl } = await mintBrowserSession(
        '00000000-0000-0000-0000-000000000007',
      );
      assert.equal(accountUrl, 'https://self.example/portal');
    } finally {
      delete process.env.ENDSTATE_ACCOUNT_PORTAL_URL;
    }
  });
});

describe('redeemBrowserSession', () => {
  it('mints a cookie session for a valid token', async () => {
    const { mintBrowserSession, redeemBrowserSession } = await import(
      '../browser-session'
    );
    const { sessionToken } = await mintBrowserSession(
      '00000000-0000-0000-0000-000000000007',
    );
    const result = await redeemBrowserSession(sessionToken);
    assert.equal(result.userId, '00000000-0000-0000-0000-000000000007');
    assert.equal(typeof result.cookieSessionId, 'string');
    assert.ok(result.cookieSessionId.length >= 32);
    assert.ok(result.cookieExpiresAt.getTime() > Date.now());
    // ~1h TTL
    const ttlMs = result.cookieExpiresAt.getTime() - Date.now();
    assert.ok(ttlMs > 50 * 60_000 && ttlMs <= 60 * 60_000 + 1000);
  });

  it('rejects replay of the same token (jti burned)', async () => {
    const { mintBrowserSession, redeemBrowserSession } = await import(
      '../browser-session'
    );
    const { sessionToken } = await mintBrowserSession(
      '00000000-0000-0000-0000-000000000007',
    );
    await redeemBrowserSession(sessionToken);
    await assert.rejects(
      () => redeemBrowserSession(sessionToken),
      /BROWSER_SESSION_CONSUMED|already been redeemed/i,
    );
  });

  it('rejects an access token (wrong audience)', async () => {
    const { mintAccessToken } = await import('../jwt');
    const { redeemBrowserSession } = await import('../browser-session');
    const { token } = await mintAccessToken({
      userId: '00000000-0000-0000-0000-000000000007',
      subscriptionStatus: 'active',
    });
    await assert.rejects(
      () => redeemBrowserSession(token),
      /wrong audience/,
    );
  });
});

describe('resolveAccountSession / invalidateAccountSession', () => {
  it('round-trips a freshly minted session', async () => {
    const {
      mintBrowserSession,
      redeemBrowserSession,
      resolveAccountSession,
      invalidateAccountSession,
    } = await import('../browser-session');
    const { sessionToken } = await mintBrowserSession(
      '00000000-0000-0000-0000-000000000007',
    );
    const { cookieSessionId } = await redeemBrowserSession(sessionToken);

    const resolved = await resolveAccountSession(cookieSessionId);
    assert.deepEqual(resolved, {
      userId: '00000000-0000-0000-0000-000000000007',
    });

    await invalidateAccountSession(cookieSessionId);
    const afterInvalidate = await resolveAccountSession(cookieSessionId);
    assert.equal(afterInvalidate, null);
  });
});
