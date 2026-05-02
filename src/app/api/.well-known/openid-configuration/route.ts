import { NextResponse } from 'next/server';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import type { OidcDiscoveryDocument } from '@/lib/hosted-backup/types';
import { KDF_FLOOR } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';
export const revalidate = 300;

function getIssuer(): string {
  return process.env.ENDSTATE_OIDC_ISSUER_URL ?? 'https://substratesystems.io';
}

export async function GET() {
  const issuer = getIssuer();
  const body: OidcDiscoveryDocument = {
    issuer,
    jwks_uri: `${issuer}/api/.well-known/jwks.json`,
    id_token_signing_alg_values_supported: ['EdDSA'],
    endstate_extensions: {
      auth_signup_endpoint: `${issuer}/api/auth/signup`,
      auth_login_endpoint: `${issuer}/api/auth/login`,
      auth_refresh_endpoint: `${issuer}/api/auth/refresh`,
      auth_logout_endpoint: `${issuer}/api/auth/logout`,
      auth_recover_endpoint: `${issuer}/api/auth/recover`,
      backup_api_base: `${issuer}/api/backups`,
      supported_kdf_algorithms: ['argon2id'],
      supported_envelope_versions: [1],
      min_kdf_params: {
        memory: KDF_FLOOR.memory,
        iterations: KDF_FLOOR.iterations,
        parallelism: KDF_FLOOR.parallelism,
      },
    },
  };
  const res = NextResponse.json(body);
  res.headers.set(
    'Cache-Control',
    'public, s-maxage=300, stale-while-revalidate=60',
  );
  return withApiVersion(res);
}
