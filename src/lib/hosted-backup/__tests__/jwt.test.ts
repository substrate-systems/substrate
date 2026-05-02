import { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = '7e'.repeat(32);
const FIXED_KID = 'hb-test-kid';

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

before(async () => {
  process.env.ENDSTATE_JWT_PRIVATE_KEY_HEX = FIXED_SEED_HEX;
  process.env.ENDSTATE_JWT_ACTIVE_KID = FIXED_KID;
  process.env.ENDSTATE_OIDC_ISSUER_URL = 'https://test.substratesystems.io';
});

after(async () => {
  const { __setKeysProvider } = await import('../jwt');
  __setKeysProvider(null);
});

async function installTestKeysProvider() {
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
}

function decodeJwtPayload<T>(token: string): T {
  const part = token.split('.')[1];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

function decodeJwtHeader<T>(token: string): T {
  const part = token.split('.')[0];
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T;
}

describe('mintAccessToken', () => {
  it('produces a JWT with the locked claims', async () => {
    const { mintAccessToken } = await import('../jwt');
    const { token, exp, iat } = await mintAccessToken({
      userId: '00000000-0000-0000-0000-000000000001',
      subscriptionStatus: 'none',
    });
    const claims = decodeJwtPayload<{
      iss: string;
      sub: string;
      aud: string;
      iat: number;
      exp: number;
      nbf: number;
      jti: string;
      subscription_status: string;
    }>(token);
    assert.equal(claims.iss, 'https://test.substratesystems.io');
    assert.equal(claims.aud, 'endstate-backup');
    assert.equal(claims.sub, '00000000-0000-0000-0000-000000000001');
    assert.equal(claims.exp - claims.iat, 900);
    assert.equal(claims.nbf, claims.iat);
    assert.equal(claims.subscription_status, 'none');
    assert.equal(typeof claims.jti, 'string');
    assert.equal(exp, claims.exp);
    assert.equal(iat, claims.iat);
  });

  it('produces a header with the active kid and EdDSA alg', async () => {
    const { mintAccessToken } = await import('../jwt');
    const { token } = await mintAccessToken({
      userId: '00000000-0000-0000-0000-000000000002',
      subscriptionStatus: 'active',
    });
    const header = decodeJwtHeader<{ alg: string; typ: string; kid: string }>(token);
    assert.equal(header.alg, 'EdDSA');
    assert.equal(header.typ, 'JWT');
    assert.equal(header.kid, FIXED_KID);
  });
});

describe('verifyAccessToken', () => {
  it('round-trips a freshly-minted token', async () => {
    await installTestKeysProvider();
    const { mintAccessToken, verifyAccessToken } = await import('../jwt');
    const { token } = await mintAccessToken({
      userId: 'user-123',
      subscriptionStatus: 'active',
    });
    const claims = await verifyAccessToken(token);
    assert.equal(claims.userId, 'user-123');
    assert.equal(claims.subscriptionStatus, 'active');
  });

  it('rejects a token signed with a different kid (unknown to provider)', async () => {
    const { mintAccessToken, __setKeysProvider, verifyAccessToken } = await import(
      '../jwt'
    );
    // Provider returns no matching kid
    __setKeysProvider(async () => []);
    const { token } = await mintAccessToken({
      userId: 'user-123',
      subscriptionStatus: 'none',
    });
    await assert.rejects(verifyAccessToken(token), (err: Error) =>
      String((err as unknown as { code: string }).code) === 'INVALID_TOKEN',
    );
    await installTestKeysProvider();
  });

  it('rejects a tampered payload', async () => {
    await installTestKeysProvider();
    const { mintAccessToken, verifyAccessToken } = await import('../jwt');
    const { token } = await mintAccessToken({
      userId: 'user-123',
      subscriptionStatus: 'none',
    });
    const parts = token.split('.');
    // Re-encode payload with a swapped sub claim
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    payload.sub = 'attacker';
    parts[1] = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const tampered = parts.join('.');
    await assert.rejects(verifyAccessToken(tampered), (err: Error) =>
      String((err as unknown as { code: string }).code) === 'INVALID_TOKEN',
    );
  });

  it('rejects wrong audience', async () => {
    await installTestKeysProvider();
    const { mintRecoveryToken, verifyAccessToken } = await import('../jwt');
    const { token } = await mintRecoveryToken({ userId: 'user-x' });
    await assert.rejects(verifyAccessToken(token), (err: Error) =>
      String((err as unknown as { code: string }).code) === 'INVALID_TOKEN',
    );
  });

  it('rejects expired token', async () => {
    await installTestKeysProvider();
    // Build an expired token by manually constructing & signing
    const { _internal } = await import('../jwt');
    const exp = Math.floor(Date.now() / 1000) - 60;
    const token = await _internal.signCompactJwt({
      iss: 'https://test.substratesystems.io',
      sub: 'user-z',
      aud: 'endstate-backup',
      iat: exp - 900,
      nbf: exp - 900,
      exp,
      jti: '00000000-0000-0000-0000-000000000099',
      subscription_status: 'none',
    });
    const { verifyAccessToken } = await import('../jwt');
    await assert.rejects(verifyAccessToken(token), (err: Error) =>
      String((err as unknown as { code: string }).code) === 'TOKEN_EXPIRED',
    );
  });

  it('rejects wrong issuer', async () => {
    await installTestKeysProvider();
    const { _internal, verifyAccessToken } = await import('../jwt');
    const iat = Math.floor(Date.now() / 1000);
    const token = await _internal.signCompactJwt({
      iss: 'https://attacker.example.com',
      sub: 'user-z',
      aud: 'endstate-backup',
      iat,
      nbf: iat,
      exp: iat + 900,
      jti: '00000000-0000-0000-0000-000000000098',
      subscription_status: 'none',
    });
    await assert.rejects(verifyAccessToken(token), (err: Error) =>
      String((err as unknown as { code: string }).code) === 'INVALID_TOKEN',
    );
  });
});
