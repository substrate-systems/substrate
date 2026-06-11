/**
 * Tests for the shared cron bearer-secret gate (used by claim-followups and
 * backup-gc). Fail-closed: unset CRON_SECRET rejects everything.
 */

import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCronAuth } from '../cron-auth';

function reqWithAuth(header?: string) {
  return new Request('https://test.local/api/cron/backup-gc', {
    method: 'GET',
    headers: header ? { authorization: header } : {},
  }) as unknown as import('next/server').NextRequest;
}

const ORIGINAL = process.env.CRON_SECRET;

beforeEach(() => {
  process.env.CRON_SECRET = 's3cret';
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL;
});

describe('verifyCronAuth', () => {
  it('accepts the correct bearer secret', () => {
    assert.equal(verifyCronAuth(reqWithAuth('Bearer s3cret')).ok, true);
  });

  it('accepts case-insensitive scheme and trims the token', () => {
    assert.equal(verifyCronAuth(reqWithAuth('bearer  s3cret ')).ok, true);
  });

  it('rejects a wrong secret', () => {
    assert.equal(verifyCronAuth(reqWithAuth('Bearer nope')).ok, false);
  });

  it('rejects a missing Authorization header', () => {
    assert.equal(verifyCronAuth(reqWithAuth()).ok, false);
  });

  it('rejects a non-bearer scheme', () => {
    assert.equal(verifyCronAuth(reqWithAuth('Basic s3cret')).ok, false);
  });

  it('fails closed when CRON_SECRET is unset', () => {
    delete process.env.CRON_SECRET;
    assert.equal(verifyCronAuth(reqWithAuth('Bearer s3cret')).ok, false);
  });
});
