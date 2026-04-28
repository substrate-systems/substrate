import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as ed from '@noble/ed25519';
import { sha512 } from '@noble/hashes/sha2.js';

const FIXED_SEED_HEX = '42'.repeat(32);

before(() => {
  process.env.ENDSTATE_LICENSE_PRIVATE_KEY = FIXED_SEED_HEX;
  // The production crypto module wires these up at import time, but set them
  // here too so the test's independent computation works regardless of import
  // ordering.
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  ed.hashes.sha512Async = async (msg: Uint8Array) => sha512(msg);
});

describe('signActivationCanonical', () => {
  const licenseKey = 'test-key';
  const fingerprint = 'test-fp';
  const activatedAt = '2026-01-01T00:00:00Z';
  const expiresAt = '';

  it('matches an independently-derived canonical Ed25519 signature', async () => {
    const { signActivationCanonical } = await import('../crypto.js');

    const expectedHash = createHash('sha256')
      .update(
        Buffer.concat([
          Buffer.from(licenseKey, 'utf8'),
          Buffer.from(fingerprint, 'utf8'),
          Buffer.from(activatedAt, 'utf8'),
          Buffer.from(expiresAt, 'utf8'),
        ]),
      )
      .digest();
    assert.equal(expectedHash.length, 32);

    const seed = new Uint8Array(Buffer.from(FIXED_SEED_HEX, 'hex'));
    const { secretKey } = await ed.keygenAsync(seed);
    const expectedSigBytes = await ed.signAsync(
      new Uint8Array(expectedHash),
      secretKey,
    );
    const expectedB64 = Buffer.from(expectedSigBytes).toString('base64');

    const actualB64 = await signActivationCanonical({
      licenseKey,
      fingerprint,
      activatedAt,
      expiresAt,
    });

    assert.equal(actualB64, expectedB64);
  });

  it('produces a different signature when fingerprint changes (payload ordering guard)', async () => {
    const { signActivationCanonical } = await import('../crypto.js');
    const base = await signActivationCanonical({
      licenseKey,
      fingerprint,
      activatedAt,
      expiresAt,
    });
    const changed = await signActivationCanonical({
      licenseKey,
      fingerprint: 'OTHER',
      activatedAt,
      expiresAt,
    });
    assert.notEqual(base, changed);
  });

  it('treats expiresAt null/undefined identically to empty string', async () => {
    const { signActivationCanonical } = await import('../crypto.js');
    const empty = await signActivationCanonical({
      licenseKey,
      fingerprint,
      activatedAt,
      expiresAt: '',
    });
    const nullish = await signActivationCanonical({
      licenseKey,
      fingerprint,
      activatedAt,
      expiresAt: null,
    });
    const undef = await signActivationCanonical({
      licenseKey,
      fingerprint,
      activatedAt,
      expiresAt: undefined,
    });
    assert.equal(nullish, empty);
    assert.equal(undef, empty);
  });
});
