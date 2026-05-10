/**
 * Tests for POST /api/auth/recover (step 3). Contract §6.
 *
 * Covers the v2.0 response shape: { recoveryToken, recoveryKeyWrappedDEK,
 * ttlSeconds }.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = '7e'.repeat(32);
const FIXED_KID = 'hb-test-kid-recover-route';

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

async function setupMocks() {
  // Stub everything the recover route reaches into. The verifyServerSecret
  // path needs a stored hash; we feed a hash that matches our test proof.
  const { hashServerSecret } = await import('../kdf');
  const proofBytes = new Uint8Array(32).fill(0xA5);
  const storedHash = await hashServerSecret(proofBytes);

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
      findUserByEmail: async () => ({
        id: 'u-r-1',
        email: 'recover@example.com',
        email_verified_at: null,
        created_at: new Date().toISOString(),
        deleted_at: null,
      }),
      getAuthCredentials: async () => ({
        user_id: 'u-r-1',
        server_password_hash: 'unused-here',
        client_salt: new Uint8Array(16),
        kdf_params: { algorithm: 'argon2id', memory: 65536, iterations: 3, parallelism: 4 },
        wrapped_dek: new Uint8Array(60),
        recovery_key_verifier: storedHash,
        recovery_key_wrapped_dek: new Uint8Array(60).fill(0xCC),
        updated_at: new Date().toISOString(),
      }),
    },
  });
}

afterEach(() => {
  mock.reset();
});

describe('recover route — v2.0 response shape', () => {
  it('returns ttlSeconds = 600, recoveryToken, recoveryKeyWrappedDEK', async () => {
    await setupMocks();
    const proofB64 = Buffer.alloc(32, 0xA5).toString('base64');
    const req = new Request('https://test.local/api/auth/recover', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'recover@example.com',
        recoveryKeyProof: proofB64,
      }),
    }) as unknown as import('next/server').NextRequest;

    const { POST } = await import('../../../app/api/auth/recover/route');
    const res = await POST(req);
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      recoveryToken: string;
      recoveryKeyWrappedDEK: string;
      ttlSeconds: number;
    };
    assert.equal(typeof body.recoveryToken, 'string');
    assert.ok(body.recoveryToken.length > 0);
    assert.equal(typeof body.recoveryKeyWrappedDEK, 'string');
    assert.equal(body.ttlSeconds, 600, 'contract §6 says 600 seconds');
    assert.equal(res.headers.get('X-Endstate-API-Version'), '2.0');
  });
});
