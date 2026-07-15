import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

const RAW_PADDLE_ERROR =
  '{"error":{"code":"forbidden","detail":"not authorized to create customer-portal-session"}}';

class MockPaddleApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string) {
    super(`paddle api ${status}`);
    this.name = 'PaddleApiError';
    this.status = status;
    this.body = body;
  }
}

async function setupMocks() {
  mock.method(console, 'error', () => {});
  class MockNextResponse extends Response {
    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(JSON.stringify(body), {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
      });
    }
  }
  mock.module('next/server', {
    namedExports: { NextResponse: MockNextResponse },
  });
  mock.module('next/headers', {
    namedExports: { cookies: async () => ({}) },
  });
  mock.module('@/lib/hosted-backup/account-middleware', {
    namedExports: {
      requireAccountSession: async () => ({ userId: 'user-portal-test' }),
    },
  });
  mock.module('@/lib/hosted-backup/db', {
    namedExports: {
      getSubscriptionEntitlement: async () => ({
        paddleCustomerId: 'ctm_portal_test',
        paddleSubscriptionId: 'sub_portal_test',
      }),
    },
  });
  mock.module('@/lib/hosted-backup/paddle-client', {
    namedExports: {
      paddleFetch: async () =>
        new Response(RAW_PADDLE_ERROR, {
          status: 403,
          headers: { 'content-type': 'application/json' },
        }),
      PaddleApiError: MockPaddleApiError,
    },
  });
}

afterEach(() => mock.reset());

describe('POST /api/billing/portal', () => {
  it('redacts Paddle response details when portal creation is forbidden', async () => {
    await setupMocks();
    const { POST } = await import('../route');

    const res = await POST(
      new Request('https://test.local/api/billing/portal', {
        method: 'POST',
      }) as unknown as import('next/server').NextRequest,
    );

    assert.equal(res.status, 502);
    const body = (await res.json()) as {
      error: { code: string; message: string; detail?: unknown };
    };
    assert.equal(body.error.code, 'PADDLE_API_ERROR');
    assert.equal(body.error.message, 'paddle portal-session creation failed');
    assert.equal(body.error.detail, undefined);
    assert.equal(JSON.stringify(body).includes('not authorized'), false);
  });
});
