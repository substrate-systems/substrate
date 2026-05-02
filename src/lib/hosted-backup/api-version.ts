import { NextResponse } from 'next/server';
import { SchemaVersion } from './types';

/**
 * Tags a NextResponse with the contract §11 API version header. Wrap every
 * response from `/api/auth/`, `/api/account/`, `/api/.well-known/`,
 * `/api/backups/` (PR2), and `/api/webhooks/paddle` (PR3) with this.
 */
export function withApiVersion(response: NextResponse): NextResponse {
  response.headers.set('X-Endstate-API-Version', SchemaVersion);
  return response;
}

export function jsonWithApiVersion<T>(
  body: T,
  init?: number | ResponseInit,
): NextResponse {
  const status = typeof init === 'number' ? init : (init?.status ?? 200);
  const res = NextResponse.json(body, { ...(typeof init === 'object' ? init : {}), status });
  return withApiVersion(res);
}
