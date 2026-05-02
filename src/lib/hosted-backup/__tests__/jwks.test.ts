import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rowsToJwks } from '../../../app/api/.well-known/jwks.json/route';
import type { SigningKeyRow } from '../db';

function makeRow(kid: string, publicKey: Uint8Array, retired = false): SigningKeyRow {
  return {
    kid,
    public_key: publicKey,
    algorithm: 'EdDSA',
    created_at: new Date().toISOString(),
    retired_at: retired ? new Date().toISOString() : null,
  };
}

describe('rowsToJwks', () => {
  it('formats each row as a well-formed OKP/Ed25519 JWK', () => {
    const pk = new Uint8Array(32).fill(0xaa);
    const jwks = rowsToJwks([makeRow('hb-1', pk)]);
    assert.equal(jwks.keys.length, 1);
    const jwk = jwks.keys[0];
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.crv, 'Ed25519');
    assert.equal(jwk.alg, 'EdDSA');
    assert.equal(jwk.use, 'sig');
    assert.equal(jwk.kid, 'hb-1');
    assert.equal(jwk.x, Buffer.from(pk).toString('base64url'));
  });

  it('includes multiple keys when present', () => {
    const pk1 = new Uint8Array(32).fill(0x01);
    const pk2 = new Uint8Array(32).fill(0x02);
    const jwks = rowsToJwks([makeRow('hb-1', pk1), makeRow('hb-2', pk2, true)]);
    assert.equal(jwks.keys.length, 2);
    assert.deepEqual(
      jwks.keys.map((k) => k.kid),
      ['hb-1', 'hb-2'],
    );
  });

  it('returns an empty keys array when no rows', () => {
    const jwks = rowsToJwks([]);
    assert.deepEqual(jwks.keys, []);
  });
});
