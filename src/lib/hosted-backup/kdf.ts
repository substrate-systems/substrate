import argon2 from 'argon2';
import { KDF_FLOOR, type KdfParams } from './types';
import { errors } from './errors';

/**
 * Validates that client-supplied KDF parameters meet the contract §2 floor.
 * Throws `KDF_TOO_WEAK` if not.
 */
export function validateKdfParams(p: unknown): KdfParams {
  if (!p || typeof p !== 'object') {
    throw errors.kdfTooWeak({ reason: 'kdfParams missing or not an object' });
  }
  const params = p as Record<string, unknown>;
  if (params.algorithm !== KDF_FLOOR.algorithm) {
    throw errors.kdfTooWeak({
      reason: 'algorithm must be argon2id',
      received: params.algorithm,
    });
  }
  const memory = Number(params.memory);
  const iterations = Number(params.iterations);
  const parallelism = Number(params.parallelism);
  if (!Number.isFinite(memory) || memory < KDF_FLOOR.memory) {
    throw errors.kdfTooWeak({
      reason: 'memory below floor',
      floor: KDF_FLOOR.memory,
      received: params.memory,
    });
  }
  if (!Number.isFinite(iterations) || iterations < KDF_FLOOR.iterations) {
    throw errors.kdfTooWeak({
      reason: 'iterations below floor',
      floor: KDF_FLOOR.iterations,
      received: params.iterations,
    });
  }
  if (!Number.isFinite(parallelism) || parallelism < KDF_FLOOR.parallelism) {
    throw errors.kdfTooWeak({
      reason: 'parallelism below floor',
      floor: KDF_FLOOR.parallelism,
      received: params.parallelism,
    });
  }
  return { algorithm: 'argon2id', memory, iterations, parallelism };
}

// Server-side cost. The input is already 32 bytes of high-entropy KDF output
// so we don't need full client-side cost; this just ensures hash inversion is
// nontrivial if the DB leaks.
const SERVER_HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456, // ~19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/**
 * Hashes a 32-byte client-derived value (`serverPassword` or recovery proof)
 * for storage. Returns an argon2id PHC string.
 */
export async function hashServerSecret(value: Uint8Array): Promise<string> {
  return argon2.hash(Buffer.from(value), SERVER_HASH_OPTIONS);
}

/**
 * Verifies a presented value against a stored argon2id PHC hash.
 */
export async function verifyServerSecret(
  storedHash: string,
  value: Uint8Array,
): Promise<boolean> {
  try {
    return await argon2.verify(storedHash, Buffer.from(value));
  } catch {
    return false;
  }
}
