import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateKdfParams,
  hashServerSecret,
  verifyServerSecret,
} from '../kdf';

describe('validateKdfParams', () => {
  it('accepts the v1 floor exactly', () => {
    const ok = validateKdfParams({
      algorithm: 'argon2id',
      memory: 65536,
      iterations: 3,
      parallelism: 4,
    });
    assert.equal(ok.algorithm, 'argon2id');
    assert.equal(ok.memory, 65536);
    assert.equal(ok.iterations, 3);
    assert.equal(ok.parallelism, 4);
  });

  it('accepts above-floor values', () => {
    const ok = validateKdfParams({
      algorithm: 'argon2id',
      memory: 131072,
      iterations: 4,
      parallelism: 4,
    });
    assert.equal(ok.memory, 131072);
  });

  it('rejects below-floor memory', () => {
    assert.throws(
      () =>
        validateKdfParams({
          algorithm: 'argon2id',
          memory: 32768,
          iterations: 3,
          parallelism: 4,
        }),
      (err: Error) =>
        err.constructor.name === 'HostedBackupError' &&
        (err as unknown as { code: string }).code === 'KDF_TOO_WEAK',
    );
  });

  it('rejects below-floor iterations', () => {
    assert.throws(
      () =>
        validateKdfParams({
          algorithm: 'argon2id',
          memory: 65536,
          iterations: 2,
          parallelism: 4,
        }),
      (err: Error) => (err as unknown as { code: string }).code === 'KDF_TOO_WEAK',
    );
  });

  it('rejects below-floor parallelism', () => {
    assert.throws(
      () =>
        validateKdfParams({
          algorithm: 'argon2id',
          memory: 65536,
          iterations: 3,
          parallelism: 1,
        }),
      (err: Error) => (err as unknown as { code: string }).code === 'KDF_TOO_WEAK',
    );
  });

  it('rejects non-argon2id algorithm', () => {
    assert.throws(
      () =>
        validateKdfParams({
          algorithm: 'scrypt',
          memory: 65536,
          iterations: 3,
          parallelism: 4,
        }),
      (err: Error) => (err as unknown as { code: string }).code === 'KDF_TOO_WEAK',
    );
  });

  it('rejects missing kdfParams object', () => {
    assert.throws(
      () => validateKdfParams(null),
      (err: Error) => (err as unknown as { code: string }).code === 'KDF_TOO_WEAK',
    );
  });
});

describe('hashServerSecret + verifyServerSecret', () => {
  it('produces an argon2id PHC string', async () => {
    const value = new Uint8Array(32).fill(7);
    const hash = await hashServerSecret(value);
    assert.ok(hash.startsWith('$argon2id$'));
  });

  it('verifies the same value as the one that produced the hash', async () => {
    const value = new Uint8Array(32).fill(7);
    const hash = await hashServerSecret(value);
    const ok = await verifyServerSecret(hash, value);
    assert.equal(ok, true);
  });

  it('rejects a different value', async () => {
    const value = new Uint8Array(32).fill(7);
    const other = new Uint8Array(32).fill(8);
    const hash = await hashServerSecret(value);
    const ok = await verifyServerSecret(hash, other);
    assert.equal(ok, false);
  });

  it('rejects a malformed hash without throwing', async () => {
    const ok = await verifyServerSecret('not-a-real-hash', new Uint8Array(32));
    assert.equal(ok, false);
  });
});
