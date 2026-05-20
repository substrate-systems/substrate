/**
 * Tests for POST /api/billing/checkout.
 *
 * Uses the same auth bootstrapping pattern as subscription-gating.test.ts:
 * fixed JWT seed, mock signing-keys lookup, mint a real token, send a real
 * Bearer header. The Paddle fetch is intercepted via a mock of the
 * `paddle-client` module so we never reach out to the real Paddle API.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);

const FIXED_SEED_HEX = '7e'.repeat(32);
const FIXED_KID = 'hb-test-kid-checkout';

before(() => {
  process.env.ENDSTATE_JWT_PRIVATE_KEY_HEX = FIXED_SEED_HEX;
  process.env.ENDSTATE_JWT_ACTIVE_KID = FIXED_KID;
  process.env.ENDSTATE_OIDC_ISSUER_URL = 'https://test.substratesystems.io';
  process.env.PADDLE_API_KEY = 'pdl_test_key';
});

function bytesFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

type FetchCall = { path: string; init: RequestInit };
let fetchCalls: FetchCall[] = [];
let nextPaddleResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { data: { id: 'txn_abc', checkout: { url: 'https://sandbox-checkout.paddle.com/abc' } } },
};

async function setupMocks() {
  fetchCalls = [];
  mock.module('@/lib/hosted-backup/db', {
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
    },
  });
  class MockPaddleApiError extends Error {
    status: number;
    body: string;
    constructor(status: number, body: string) {
      super(`paddle api ${status}: ${body}`);
      this.name = 'PaddleApiError';
      this.status = status;
      this.body = body;
    }
  }
  mock.module('@/lib/hosted-backup/paddle-client', {
    namedExports: {
      paddleApiBaseUrl: () => 'https://sandbox-api.paddle.com',
      paddleFetch: async (path: string, init: RequestInit = {}) => {
        fetchCalls.push({ path, init });
        const r = nextPaddleResponse;
        return new Response(JSON.stringify(r.body), {
          status: r.status,
          headers: { 'content-type': 'application/json' },
        });
      },
      assertOk: async (res: Response) => {
        if (res.ok) return;
        const body = await res.text();
        throw new MockPaddleApiError(res.status, body);
      },
      PaddleApiError: MockPaddleApiError,
    },
  });
}

afterEach(() => {
  mock.reset();
  delete process.env.PADDLE_PRICE_ID_HOSTED_BACKUP;
  delete process.env.PADDLE_CHECKOUT_SUCCESS_URL;
  nextPaddleResponse = {
    ok: true,
    status: 200,
    body: { data: { id: 'txn_abc', checkout: { url: 'https://sandbox-checkout.paddle.com/abc' } } },
  };
});

function makeReqWithBearer(token: string | null): import('next/server').NextRequest {
  const headers = new Headers();
  if (token) headers.set('authorization', `Bearer ${token}`);
  return new Request('https://test.local/api/billing/checkout', {
    method: 'POST',
    headers,
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/billing/checkout', () => {
  it('returns 401 without bearer token', async () => {
    await setupMocks();
    process.env.PADDLE_PRICE_ID_HOSTED_BACKUP = 'pri_test_123';
    const { POST } = await import('../route');
    const res = await POST(makeReqWithBearer(null));
    assert.equal(res.status, 401);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'UNAUTHENTICATED');
  });

  it('returns 500 SERVER_MISCONFIGURED when PADDLE_PRICE_ID_HOSTED_BACKUP is unset', async () => {
    await setupMocks();
    delete process.env.PADDLE_PRICE_ID_HOSTED_BACKUP;
    const { mintAccessToken } = await import('@/lib/hosted-backup/jwt');
    const { POST } = await import('../route');
    const { token } = await mintAccessToken({
      userId: 'u-cfg',
      subscriptionStatus: 'none',
    });
    const res = await POST(makeReqWithBearer(token));
    assert.equal(res.status, 500);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'SERVER_MISCONFIGURED');
  });

  it('happy path returns checkoutUrl and embeds user_id in custom_data', async () => {
    await setupMocks();
    process.env.PADDLE_PRICE_ID_HOSTED_BACKUP = 'pri_test_123';
    const { mintAccessToken } = await import('@/lib/hosted-backup/jwt');
    const { POST } = await import('../route');
    const { token } = await mintAccessToken({
      userId: 'u-checkout-1',
      subscriptionStatus: 'none',
    });
    const res = await POST(makeReqWithBearer(token));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Endstate-API-Version'), '2.0');
    const j = (await res.json()) as { checkoutUrl: string; transactionId: string };
    assert.equal(j.transactionId, 'txn_abc');
    assert.equal(j.checkoutUrl, 'https://sandbox-checkout.paddle.com/abc');

    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].path, '/transactions');
    assert.equal(fetchCalls[0].init.method, 'POST');
    const body = JSON.parse(fetchCalls[0].init.body as string) as {
      items: Array<{ price_id: string; quantity: number }>;
      custom_data: { user_id: string };
    };
    assert.equal(body.items[0].price_id, 'pri_test_123');
    assert.equal(body.items[0].quantity, 1);
    assert.equal(body.custom_data.user_id, 'u-checkout-1');
  });

  it('surfaces Paddle non-2xx as PADDLE_API_ERROR 502', async () => {
    await setupMocks();
    process.env.PADDLE_PRICE_ID_HOSTED_BACKUP = 'pri_test_123';
    nextPaddleResponse = {
      ok: false,
      status: 422,
      body: { error: { code: 'invalid_price_id' } },
    };
    const { mintAccessToken } = await import('@/lib/hosted-backup/jwt');
    const { POST } = await import('../route');
    const { token } = await mintAccessToken({
      userId: 'u-err',
      subscriptionStatus: 'none',
    });
    const res = await POST(makeReqWithBearer(token));
    assert.equal(res.status, 502);
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'PADDLE_API_ERROR');
  });
});
