import assert from 'node:assert/strict';
import { afterEach, before, describe, it, mock } from 'node:test';

type Email = { to: string; subject: string };
let sentEmails: Email[] = [];

class TestPaddleSignatureError extends Error {}

before(() => {
  mock.module('@/lib/brevo', {
    namedExports: {
      sendTransactionalEmail: async (message: Email) => {
        sentEmails.push(message);
        return { success: true, messageId: 'msg_test' };
      },
    },
  });

  mock.module('@/lib/license/paddle', {
    namedExports: {
      PaddleSignatureError: TestPaddleSignatureError,
      verifyPaddleSignature: () => undefined,
      extractTransactionFields: (event: {
        data: { id: string; customer: { email: string } };
      }) => ({
        transactionId: event.data.id,
        email: event.data.customer.email,
        customerId: null,
      }),
      fetchPaddleCustomerEmail: async () => null,
    },
  });
});

afterEach(() => {
  sentEmails = [];
  delete process.env.PADDLE_WEBHOOK_SECRET;
  delete process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
});

function requestFor(priceId: string): import('next/server').NextRequest {
  return new Request('https://substratesystems.io/api/license/webhook', {
    method: 'POST',
    headers: { 'paddle-signature': 'ts=1;h1=test' },
    body: JSON.stringify({
      event_type: 'transaction.completed',
      data: {
        id: 'txn_test',
        customer: { email: 'supporter@example.com' },
        items: [{ price: { id: priceId } }],
      },
    }),
  }) as unknown as import('next/server').NextRequest;
}

describe('POST /api/license/webhook', () => {
  it('fails retryably when the sole Supporter price is not configured', async () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'secret';
    const { POST } = await import('../route');

    const response = await POST(requestFor('pri_supporter'));

    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), {
      error: 'server_misconfigured',
      message: 'NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER is not set',
    });
    assert.equal(sentEmails.length, 0);
  });

  it('keeps the recognition-only Supporter flow', async () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'secret';
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = 'pri_supporter';
    const { POST } = await import('../route');

    const response = await POST(requestFor('pri_supporter'));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, supporter: true });
    assert.deepEqual(
      sentEmails.map(({ to }) => to),
      ['founder@substratesystems.io', 'supporter@example.com'],
    );
  });

  it('acknowledges and ignores every other one-time SKU', async () => {
    process.env.PADDLE_WEBHOOK_SECRET = 'secret';
    process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER = 'pri_supporter';
    const { POST } = await import('../route');

    const response = await POST(requestFor('pri_retired_or_unknown'));

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ignored: true,
      reason: 'no handler for transaction',
    });
    assert.equal(sentEmails.length, 0);
  });
});
