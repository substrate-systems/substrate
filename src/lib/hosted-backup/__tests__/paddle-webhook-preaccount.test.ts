/**
 * Webhook pre-account path tests — covers the email-fallback resolution
 * introduced in wire-anonymous-buyer-account-linking. When subscription.created
 * arrives without custom_data.user_id AND without a paddle_customer_id match,
 * the webhook falls back to:
 *   1. fetchPaddleCustomerEmail(customer_id) via the Paddle API
 *   2. ensurePreAccount(email) — creates or fetches the users row
 *   3. either mintClaimToken + claim email (pre-account) or FYI (real user)
 */

import { afterEach, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

const SECRET = 'test-paddle-secret';

before(() => {
  process.env.PADDLE_WEBHOOK_SECRET = SECRET;
  process.env.NODE_ENV = 'test';
});

class PaddleSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaddleSignatureError';
  }
}

function signedHeader(rawBody: string, ts: number = Math.floor(Date.now() / 1000)): string {
  const h1 = createHmac('sha256', SECRET).update(`${ts}:${rawBody}`).digest('hex');
  return `ts=${ts};h1=${h1}`;
}

function makeReq(body: object): Request {
  const rawBody = JSON.stringify(body);
  return new Request('https://test.local/api/webhooks/paddle', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'paddle-signature': signedHeader(rawBody),
    },
    body: rawBody,
  });
}

type State = {
  events: Map<string, { eventType: string; processedAt: string | null }>;
  customerIdToUserId: Map<string, string>;
  customerIdToEmail: Map<string, string | null>;
  upserts: Array<{
    userId: string;
    paddleSubscriptionId: string;
    paddleCustomerId: string;
    status: string;
    plan: string | null;
  }>;
  users: Map<string, { id: string; hasCreds: boolean }>;
  claimMints: Array<{ userId: string; email: string }>;
  paddleFetchErrors: Set<string>;
};

let state: State;

function setupMocks(opts: {
  customerIdToEmail?: Record<string, string | null>;
  existingUsers?: Array<{ email: string; id: string; hasCreds: boolean }>;
  paddleFetchErrorsFor?: string[];
} = {}) {
  state = {
    events: new Map(),
    customerIdToUserId: new Map(),
    customerIdToEmail: new Map(Object.entries(opts.customerIdToEmail ?? {})),
    upserts: [],
    users: new Map(
      (opts.existingUsers ?? []).map((u) => [u.email, { id: u.id, hasCreds: u.hasCreds }]),
    ),
    claimMints: [],
    paddleFetchErrors: new Set(opts.paddleFetchErrorsFor ?? []),
  };

  mock.module('../db', {
    namedExports: {
      recordPaddleEventIfFresh: async (p: { eventId: string; eventType: string }) => {
        if (state.events.has(p.eventId)) return false;
        state.events.set(p.eventId, { eventType: p.eventType, processedAt: null });
        return true;
      },
      markPaddleEventProcessed: async (eventId: string) => {
        const ev = state.events.get(eventId);
        if (ev) ev.processedAt = new Date().toISOString();
      },
      findUserIdByPaddleCustomerId: async (cid: string) =>
        state.customerIdToUserId.get(cid) ?? null,
      upsertSubscription: async (p: {
        userId: string;
        paddleSubscriptionId: string;
        paddleCustomerId: string;
        status: string;
        plan?: string | null;
      }) => {
        state.upserts.push({
          userId: p.userId,
          paddleSubscriptionId: p.paddleSubscriptionId,
          paddleCustomerId: p.paddleCustomerId,
          status: p.status,
          plan: p.plan ?? null,
        });
      },
      ensurePreAccount: async (email: string) => {
        const existing = state.users.get(email);
        if (existing) return { userId: existing.id, isNew: false };
        const id = `u-${state.users.size + 1}-${email.replace(/[^a-z]/gi, '').slice(0, 6)}`;
        state.users.set(email, { id, hasCreds: false });
        return { userId: id, isNew: true };
      },
      userHasAuthCredentials: async (userId: string) => {
        for (const u of state.users.values()) {
          if (u.id === userId) return u.hasCreds;
        }
        return false;
      },
      findUserById: async (userId: string) => {
        for (const [email, u] of state.users) {
          if (u.id === userId) {
            return {
              id: u.id,
              email,
              email_verified_at: null,
              created_at: new Date().toISOString(),
              deleted_at: null,
            };
          }
        }
        return null;
      },
      getSubscriptionByUserId: async (userId: string) => {
        const last = [...state.upserts].reverse().find((u) => u.userId === userId);
        if (!last) return null;
        return {
          user_id: userId,
          paddle_subscription_id: last.paddleSubscriptionId,
          paddle_customer_id: last.paddleCustomerId,
          status: last.status,
          plan: last.plan,
          grace_started_at: null,
          cancel_started_at: null,
          current_period_end: null,
          updated_at: new Date().toISOString(),
        };
      },
    },
  });

  mock.module('../../license/paddle', {
    namedExports: {
      verifyPaddleSignature: ({ header, rawBody, secret }: {
        header: string | null;
        rawBody: string;
        secret: string;
      }) => {
        if (!header) throw new PaddleSignatureError('missing signature header');
        const match = /ts=(\d+);h1=([0-9a-f]+)/.exec(header);
        if (!match) throw new PaddleSignatureError('malformed signature header');
        const ts = match[1];
        const h1 = match[2];
        const expected = createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
        if (expected !== h1) throw new PaddleSignatureError('signature mismatch');
      },
      PaddleSignatureError,
      fetchPaddleCustomerEmail: async (customerId: string) => {
        if (state.paddleFetchErrors.has(customerId)) {
          throw new Error('paddle api down');
        }
        return state.customerIdToEmail.get(customerId) ?? null;
      },
    },
  });

  mock.module('../claim-tokens', {
    namedExports: {
      mintClaimToken: async (params: { userId: string; email: string }) => {
        state.claimMints.push(params);
        return { token: 'test-token-plaintext', tokenHash: new Uint8Array(32) };
      },
    },
  });
}

afterEach(() => mock.reset());

describe('Paddle webhook — email-fallback pre-account path', () => {
  it('creates a pre-account + mints claim token when subscription.created lacks user_id', async () => {
    setupMocks({
      customerIdToEmail: { cus_anon: 'new@example.com' },
    });
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const res = await POST(
      makeReq({
        event_id: 'evt_anon_1',
        event_type: 'subscription.created',
        data: {
          id: 'sub_anon_1',
          customer_id: 'cus_anon',
          items: [{ price: { id: 'pri_monthly' } }],
        },
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; userId?: string; status?: string };
    assert.equal(typeof j.userId, 'string');
    assert.equal(j.status, 'active');
    assert.equal(state.upserts.length, 1, 'subscription should be upserted');
    assert.equal(state.users.size, 1, 'pre-account user should be created');
    assert.equal(state.claimMints.length, 1, 'claim token should be minted');
    assert.equal(state.claimMints[0].email, 'new@example.com');
  });

  it('links to existing credentialed user (no claim token, no pre-account)', async () => {
    setupMocks({
      customerIdToEmail: { cus_alice: 'alice@example.com' },
      existingUsers: [{ email: 'alice@example.com', id: 'u-alice', hasCreds: true }],
    });
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const res = await POST(
      makeReq({
        event_id: 'evt_alice_1',
        event_type: 'subscription.created',
        data: {
          id: 'sub_alice_1',
          customer_id: 'cus_alice',
          items: [{ price: { id: 'pri_monthly' } }],
        },
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 200);
    assert.equal(state.upserts[0].userId, 'u-alice');
    assert.equal(state.claimMints.length, 0, 'no claim token for existing real user');
  });

  it('reuses existing pre-account but mints a fresh claim token', async () => {
    setupMocks({
      customerIdToEmail: { cus_bob: 'bob@example.com' },
      existingUsers: [{ email: 'bob@example.com', id: 'u-bob', hasCreds: false }],
    });
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const res = await POST(
      makeReq({
        event_id: 'evt_bob_1',
        event_type: 'subscription.created',
        data: {
          id: 'sub_bob_1',
          customer_id: 'cus_bob',
          items: [{ price: { id: 'pri_yearly' } }],
        },
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 200);
    assert.equal(state.upserts[0].userId, 'u-bob');
    assert.equal(state.claimMints.length, 1, 'pre-account still needs a fresh claim token');
    assert.equal(state.claimMints[0].userId, 'u-bob');
  });

  it('falls through to unknown_user when Paddle email-fetch throws', async () => {
    setupMocks({
      customerIdToEmail: { cus_oops: 'whatever@example.com' },
      paddleFetchErrorsFor: ['cus_oops'],
    });
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const res = await POST(
      makeReq({
        event_id: 'evt_oops',
        event_type: 'subscription.created',
        data: { id: 'sub_oops', customer_id: 'cus_oops' },
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; unknown_user?: boolean };
    assert.equal(j.unknown_user, true);
    assert.equal(state.upserts.length, 0);
    assert.equal(state.claimMints.length, 0);
  });

  it('does NOT use the email fallback for non-subscription.created events', async () => {
    setupMocks({
      customerIdToEmail: { cus_xx: 'who@example.com' },
    });
    const { POST } = await import('../../../app/api/webhooks/paddle/route');
    const res = await POST(
      makeReq({
        event_id: 'evt_past_due_orphan',
        event_type: 'subscription.past_due',
        data: { id: 'sub_xx', customer_id: 'cus_xx' },
      }) as unknown as import('next/server').NextRequest,
    );
    assert.equal(res.status, 200);
    const j = (await res.json()) as { ok: true; unknown_user?: boolean };
    assert.equal(j.unknown_user, true, 'past_due without prior row stays unknown_user');
    assert.equal(state.users.size, 0, 'no pre-account created for non-created events');
  });
});
