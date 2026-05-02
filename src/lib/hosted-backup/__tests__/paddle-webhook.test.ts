/**
 * Webhook handler tests using node:test module mocks.
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'test-paddle-secret';

before(() => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
});

function signedHeader(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac('sha256', SECRET).update(`${ts}:${rawBody}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

function makeReq(body: object, headerValue: string | null = null): Request {
  const rawBody = JSON.stringify(body);
  const sig = headerValue ?? signedHeader(rawBody);
  const headers = new Headers({
    'content-type': 'application/json',
    'paddle-signature': sig,
  });
  if (headerValue === '') headers.delete('paddle-signature');
  return new Request('https://test.local/api/webhooks/paddle', {
    method: 'POST',
    headers,
    body: rawBody,
  });
}

type DbState = {
  events: Map<string, { eventType: string; processedAt: string | null }>;
  freshInserts: number;
};

let state: DbState;

function setupDbMocks() {
  state = { events: new Map(), freshInserts: 0 };
  mock.module('../db', {
    namedExports: {
      recordPaddleEventIfFresh: async (params: {
        eventId: string;
        eventType: string;
      }) => {
        if (state.events.has(params.eventId)) return false;
        state.events.set(params.eventId, {
          eventType: params.eventType,
          processedAt: null,
        });
        state.freshInserts += 1;
        return true;
      },
      markPaddleEventProcessed: async (eventId: string) => {
        const ev = state.events.get(eventId);
        if (ev) ev.processedAt = new Date().toISOString();
      },
      // Subscription module imports findUserIdByPaddleCustomerId; stub it.
      findUserIdByPaddleCustomerId: async () => null,
      upsertSubscription: async () => undefined,
    },
  });
}

afterEach(() => mock.reset());

describe('Paddle webhook signature path', () => {
  it('returns 401 on missing Paddle-Signature header', async () => {
    setupDbMocks();
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const body = { event_id: 'evt_1', event_type: 'subscription.created' };
    const req = makeReq(body, '');
    const res = await POST(req as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('X-Endstate-API-Version'), '1.0');
    const j = (await res.json()) as { error: { code: string } };
    assert.equal(j.error.code, 'PADDLE_SIGNATURE_INVALID');
  });

  it('returns 401 on tampered body (signature was for different content)', async () => {
    setupDbMocks();
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const original = { event_id: 'evt_2', event_type: 'subscription.created' };
    const sig = signedHeader(JSON.stringify(original));
    const tampered = { event_id: 'evt_2_attacker', event_type: 'subscription.created' };
    const req = new Request('https://test.local/api/webhooks/paddle', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'paddle-signature': sig,
      },
      body: JSON.stringify(tampered),
    });
    const res = await POST(req as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 401);
  });
});

describe('Paddle webhook idempotency', () => {
  it('processes once; subsequent identical event_id returns 200 deduped', async () => {
    setupDbMocks();
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const body = {
      event_id: 'evt_idem',
      event_type: 'subscription.created',
      data: { id: 'sub_1', customer_id: 'cus_1' },
    };
    const req1 = makeReq(body);
    const res1 = await POST(req1 as unknown as import('next/server').NextRequest);
    assert.equal(res1.status, 200);
    assert.equal(state.freshInserts, 1);

    const req2 = makeReq(body);
    const res2 = await POST(req2 as unknown as import('next/server').NextRequest);
    assert.equal(res2.status, 200);
    const j2 = (await res2.json()) as { ok: true; deduped?: boolean };
    assert.equal(j2.deduped, true);
    // No new insert
    assert.equal(state.freshInserts, 1);
  });
});

describe('Paddle webhook unknown event types', () => {
  it('returns 200 with ignored=true for unhandled event types', async () => {
    setupDbMocks();
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const body = {
      event_id: 'evt_unknown',
      event_type: 'transaction.completed', // not in our handled set
      data: { id: 'tx_1' },
    };
    const req = makeReq(body);
    const res = await POST(req as unknown as import('next/server').NextRequest);
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; ignored?: boolean; event_type?: string };
    assert.equal(j.ignored, true);
    assert.equal(j.event_type, 'transaction.completed');
  });
});
