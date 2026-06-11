/**
 * Tests for the DB-backed rate limiter: threshold semantics, key hashing
 * (no plaintext emails/IPs at rest), per-key isolation, and best-effort
 * recording.
 */

import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

type RlState = {
  counts: Record<string, number>; // `${scope}|${hashedKey}` -> count
  inserts: Array<{ scope: string; key: string }>;
  insertFails: boolean;
};

let state: RlState;

function setup(overrides: Partial<RlState> = {}) {
  state = { counts: {}, inserts: [], insertFails: false, ...overrides };
  mock.module('../db', {
    namedExports: {
      countRateLimitEvents: async (params: {
        scope: string;
        key: string;
        windowSeconds: number;
      }) => state.counts[`${params.scope}|${params.key}`] ?? 0,
      insertRateLimitEvent: async (params: { scope: string; key: string }) => {
        if (state.insertFails) throw new Error('simulated insert failure');
        state.inserts.push(params);
      },
    },
  });
}

afterEach(() => mock.reset());

describe('enforceRateLimit', () => {
  it('passes under the limit', async () => {
    setup();
    const { enforceRateLimit, RATE_LIMITS } = await import('../rate-limit');
    await enforceRateLimit(RATE_LIMITS.loginPerAccount, 'a@example.com');
  });

  it('throws RATE_LIMITED (429) at the limit', async () => {
    setup();
    const { enforceRateLimit, recordRateLimitEvent, RATE_LIMITS } =
      await import('../rate-limit');
    const { HostedBackupError } = await import('../errors');
    // Seed the count via the same hashing path the limiter uses.
    await recordRateLimitEvent(RATE_LIMITS.loginPerAccount, 'a@example.com');
    const hashed = state.inserts[0].key;
    state.counts[`login:account|${hashed}`] = RATE_LIMITS.loginPerAccount.limit;

    await assert.rejects(
      enforceRateLimit(RATE_LIMITS.loginPerAccount, 'a@example.com'),
      (err: unknown) => {
        assert.ok(err instanceof HostedBackupError);
        assert.equal(err.code, 'RATE_LIMITED');
        assert.equal(err.status, 429);
        return true;
      },
    );
  });

  it('isolates keys: one throttled account does not affect another', async () => {
    setup();
    const { enforceRateLimit, recordRateLimitEvent, RATE_LIMITS } =
      await import('../rate-limit');
    await recordRateLimitEvent(RATE_LIMITS.loginPerAccount, 'hot@example.com');
    const hot = state.inserts[0].key;
    state.counts[`login:account|${hot}`] = 999;

    await assert.rejects(
      enforceRateLimit(RATE_LIMITS.loginPerAccount, 'hot@example.com'),
    );
    // Different key — same scope — sails through.
    await enforceRateLimit(RATE_LIMITS.loginPerAccount, 'cold@example.com');
  });
});

describe('recordRateLimitEvent', () => {
  it('stores sha256-hashed keys, never the plaintext email/IP', async () => {
    setup();
    const { recordRateLimitEvent, RATE_LIMITS } = await import('../rate-limit');
    await recordRateLimitEvent(RATE_LIMITS.loginPerIp, '203.0.113.7');
    assert.equal(state.inserts.length, 1);
    assert.equal(state.inserts[0].scope, 'login:ip');
    assert.match(state.inserts[0].key, /^[0-9a-f]{64}$/);
    assert.notEqual(state.inserts[0].key, '203.0.113.7');
  });

  it('is best-effort: an insert failure does not throw', async () => {
    setup({ insertFails: true });
    const { recordRateLimitEvent, RATE_LIMITS } = await import('../rate-limit');
    await recordRateLimitEvent(RATE_LIMITS.signupPerIp, '203.0.113.7');
  });
});

describe('clientIpFrom', () => {
  it('takes the first x-forwarded-for hop and falls back to unknown', async () => {
    const { clientIpFrom } = await import('../rate-limit');
    const withXff = new Request('https://test.local/', {
      headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' },
    }) as unknown as import('next/server').NextRequest;
    assert.equal(clientIpFrom(withXff), '203.0.113.7');

    const without = new Request(
      'https://test.local/',
    ) as unknown as import('next/server').NextRequest;
    assert.equal(clientIpFrom(without), 'unknown');
  });
});
