import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

before(() => {
  process.env.ENDSTATE_OIDC_ISSUER_URL = 'https://test.substratesystems.io';
});

describe('GET /api/.well-known/openid-configuration', () => {
  it('returns the standard OIDC fields and the endstate_extensions block', async () => {
    const { GET } = await import(
      '../../../app/api/.well-known/openid-configuration/route'
    );
    const res = await GET();
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('X-Endstate-API-Version'), '1.0');
    assert.match(
      res.headers.get('Cache-Control') ?? '',
      /public, s-maxage=300, stale-while-revalidate=60/,
    );
    const body = (await res.json()) as Record<string, unknown> & {
      endstate_extensions: Record<string, unknown>;
    };
    assert.equal(body.issuer, 'https://test.substratesystems.io');
    assert.equal(
      body.jwks_uri,
      'https://test.substratesystems.io/api/.well-known/jwks.json',
    );
    assert.deepEqual(body.id_token_signing_alg_values_supported, ['EdDSA']);
    assert.ok(body.endstate_extensions);
    const ext = body.endstate_extensions;
    assert.deepEqual(ext.supported_kdf_algorithms, ['argon2id']);
    assert.deepEqual(ext.supported_envelope_versions, [1]);
    assert.deepEqual(ext.min_kdf_params, {
      memory: 65536,
      iterations: 3,
      parallelism: 4,
    });
    assert.equal(
      ext.auth_signup_endpoint,
      'https://test.substratesystems.io/api/auth/signup',
    );
    assert.equal(
      ext.auth_login_endpoint,
      'https://test.substratesystems.io/api/auth/login',
    );
    assert.equal(
      ext.auth_refresh_endpoint,
      'https://test.substratesystems.io/api/auth/refresh',
    );
    assert.equal(
      ext.auth_logout_endpoint,
      'https://test.substratesystems.io/api/auth/logout',
    );
    assert.equal(
      ext.auth_recover_endpoint,
      'https://test.substratesystems.io/api/auth/recover',
    );
    assert.equal(
      ext.backup_api_base,
      'https://test.substratesystems.io/api/backups',
    );
  });
});
