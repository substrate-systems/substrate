/**
 * Tests the PENDING_CLAIM collision path on POST /api/auth/signup.
 *
 * A `users` row without `auth_credentials` (pre-account from an anonymous
 * marketing-page purchase) MUST NOT be takeable by anyone who happens to
 * know the email — otherwise an attacker could hijack the buyer's
 * subscription before the legit buyer clicks the email link.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = 'b2'.repeat(32);
const FIXED_KID = 'hb-test-kid-signup-pc';

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

function setupMocks(opts: {
  existingUserEmail?: string;
  existingUserHasCreds?: boolean;
}) {
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
      findUserByEmail: async (email: string) => {
        if (opts.existingUserEmail && email === opts.existingUserEmail) {
          return {
            id: 'u-existing',
            email,
            email_verified_at: null,
            created_at: new Date().toISOString(),
            deleted_at: null,
          };
        }
        return null;
      },
      userHasAuthCredentials: async (_userId: string) =>
        opts.existingUserHasCreds === true,
      insertUser: async () => {
        throw new Error('insertUser should not be called on collision path');
      },
      insertAuthCredentials: async () => {},
      getSubscriptionStatus: async () => 'none',
      insertRefreshToken: async () => {
        throw new Error('insertRefreshToken should not be called on collision');
      },
    },
  });
}

function makeReq(email: string): Request {
  return new Request('https://test.local/api/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      serverPassword: Buffer.alloc(32, 0x11).toString('base64'),
      salt: Buffer.alloc(16, 0x22).toString('base64'),
      kdfParams: {
        algorithm: 'argon2id',
        memory: 65536,
        iterations: 3,
        parallelism: 4,
      },
      wrappedDEK: Buffer.alloc(60, 0x33).toString('base64'),
      recoveryKeyVerifier: Buffer.alloc(32, 0x44).toString('base64'),
      recoveryKeyWrappedDEK: Buffer.alloc(60, 0x55).toString('base64'),
    }),
  });
}

afterEach(() => mock.reset());

describe('POST /api/auth/signup — pre-account collision', () => {
  it('returns 409 PENDING_CLAIM for an email matching a pre-account', async () => {
    setupMocks({
      existingUserEmail: 'pending@example.com',
      existingUserHasCreds: false,
    });
    const { POST } = await import('../../../app/api/auth/signup/route');
    const res = await POST(
      makeReq('pending@example.com') as unknown as import('next/server').NextRequest,
    );
    const text = await res.text();
    assert.equal(res.status, 409, text);
    const j = JSON.parse(text) as { error: { code: string } };
    assert.equal(j.error.code, 'PENDING_CLAIM');
  });

  // The EMAIL_TAKEN path for fully-credentialed users is the pre-existing
  // signup behavior — it doesn't regress with this PR. Skipping a separate
  // assertion here to avoid coupling this test to the signup route's
  // unrelated credential-validation order; the PENDING_CLAIM case above is
  // the load-bearing one for this change.
});
