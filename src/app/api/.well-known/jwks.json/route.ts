import { NextResponse } from 'next/server';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import { errorResponse } from '@/lib/hosted-backup/errors';
import { getJwksKeys, type SigningKeyRow } from '@/lib/hosted-backup/db';
import type { Jwk, Jwks } from '@/lib/hosted-backup/types';

export const runtime = 'nodejs';
export const revalidate = 300;

export function rowsToJwks(rows: SigningKeyRow[]): Jwks {
  const keys: Jwk[] = rows.map((row) => ({
    kty: 'OKP',
    crv: 'Ed25519',
    alg: 'EdDSA',
    use: 'sig',
    kid: row.kid,
    x: Buffer.from(row.public_key).toString('base64url'),
  }));
  return { keys };
}

export async function GET() {
  try {
    const rows = await getJwksKeys();
    const body = rowsToJwks(rows);
    const res = NextResponse.json(body);
    res.headers.set(
      'Cache-Control',
      'public, s-maxage=300, stale-while-revalidate=60',
    );
    return withApiVersion(res);
  } catch (err) {
    console.error('[hosted-backup jwks] unhandled:', err);
    return errorResponse(err);
  }
}
