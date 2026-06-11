/**
 * Route-level rate-limit wiring tests for POST /api/auth/login — the spec's
 * headline scenarios: a successful login consumes no budget, a saturated
 * per-account window 429s before credentials are checked, and failures
 * record events.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  process.env.ENDSTATE_JWT_PRIVATE_KEY_HEX = '7e'.repeat(32);
  process.env.ENDSTATE_JWT_ACTIVE_KID = 'hb-test-kid-login-rl';
  process.env.ENDSTATE_OIDC_ISSUER_URL = 'https://test.substratesystems.io';
});

type LoginRlState = {
  counts: Record<string, number>; // scope -> count (any key)
  inserts: Array<{ scope: string; key: string }>;
  verifyOk: boolean;
  userExists: boolean;
};

let state: LoginRlState;

async function setupMocks(opts: Partial<LoginRlState> = {}) {
  state = {
    counts: {},
    inserts: [],
    verifyOk: true,
    userExists: true,
    ...opts,
  };

  const { hashServerSecret } = await import('../kdf');
  const passwordBytes = new Uint8Array(32).fill(0x5a);
  const storedHash = await hashServerSecret(passwordBytes);

  mock.module('../db', {
    namedExports: {
      findUserByEmail: async () =>
        state.userExists
          ? {
              id: 'u-l-1',
              email: 'login@example.com',
              email_verified_at: null,
              created_at: new Date().toISOString(),
              deleted_at: null,
            }
          : null,
      getAuthCredentials: async () => ({
        user_id: 'u-l-1',
        server_password_hash: storedHash,
        client_salt: new Uint8Array(16),
        kdf_params: {
          algorithm: 'argon2id',
          memory: 65536,
          iterations: 3,
          parallelism: 4,
        },
        wrapped_dek: new Uint8Array(60),
        recovery_key_verifier: 'unused-here',
        recovery_key_wrapped_dek: new Uint8Array(60),
        updated_at: new Date().toISOString(),
      }),
      getSubscriptionStatus: async () => 'active',
      countRateLimitEvents: async (params: { scope: string }) =>
        state.counts[params.scope] ?? 0,
      insertRateLimitEvent: async (params: { scope: string; key: string }) => {
        state.inserts.push(params);
      },
    },
  });
  mock.module('../jwt', {
    namedExports: {
      mintAccessToken: async () => ({ token: 'at-test' }),
    },
  });
  mock.module('../refresh', {
    namedExports: {
      issueFreshChain: async () => ({ token: 'rt-test' }),
    },
  });
  // The route imports verifyServerSecret from ../kdf; mock it so the test
  // controls pass/fail without computing a second Argon2 hash per case.
  mock.module('../kdf', {
    namedExports: {
      verifyServerSecret: async () => state.verifyOk,
      hashServerSecret,
    },
  });
}

function step2Req() {
  return new Request('https://test.local/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9',
    },
    body: JSON.stringify({
      email: 'login@example.com',
      serverPassword: Buffer.alloc(32, 0x5a).toString('base64'),
    }),
  }) as unknown as import('next/server').NextRequest;
}

async function postLogin() {
  const { POST } = await import('../../../app/api/auth/login/route');
  return POST(step2Req());
}

afterEach(() => mock.reset());

describe('login route — rate-limit wiring', () => {
  it('a successful login consumes no budget (zero events recorded)', async () => {
    await setupMocks({ verifyOk: true });
    const res = await postLogin();
    assert.equal(res.status, 200);
    assert.deepEqual(state.inserts, []);
  });

  it('429s on a saturated per-account window before checking credentials', async () => {
    await setupMocks({ verifyOk: true, counts: { 'login:account': 10 } });
    const res = await postLogin();
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.error.code, 'RATE_LIMITED');
  });

  it('429s on a saturated per-IP window', async () => {
    await setupMocks({ counts: { 'login:ip': 30 } });
    const res = await postLogin();
    assert.equal(res.status, 429);
  });

  it('a wrong password records both per-IP and per-account events', async () => {
    await setupMocks({ verifyOk: false });
    const res = await postLogin();
    assert.equal(res.status, 401);
    const scopes = state.inserts.map((i) => i.scope).sort();
    assert.deepEqual(scopes, ['login:account', 'login:ip']);
  });

  it('an unknown email records failure events', async () => {
    await setupMocks({ userExists: false });
    const res = await postLogin();
    assert.equal(res.status, 404);
    const scopes = state.inserts.map((i) => i.scope).sort();
    assert.deepEqual(scopes, ['login:account', 'login:ip']);
  });
});
