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

/**
 * Lowest client schema that participates in the two-phase version commit
 * (contract §7, §8). Clients advertise their schema on the REQUEST side with
 * the same `X-Endstate-API-Version` header the server sets on responses.
 */
const COMMIT_MIN_MAJOR = 2;
const COMMIT_MIN_MINOR = 1;

/**
 * Whether the caller understands `POST /api/backups/:id/versions/:vid/commit`.
 *
 * Fails closed to `false` — an absent, malformed, or older header means the
 * caller has no commit call, so its versions must remain live at creation
 * exactly as they were before the commit protocol existed. Gating such a
 * client on a commit it can never send would silently make its backups
 * invisible, which is the opposite of the durability this protocol buys.
 */
export function clientRequiresVersionCommit(
  headerValue: string | null | undefined,
): boolean {
  if (!headerValue) return false;
  const match = /^\s*(\d+)\.(\d+)/.exec(headerValue);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  if (major > COMMIT_MIN_MAJOR) return true;
  return major === COMMIT_MIN_MAJOR && minor >= COMMIT_MIN_MINOR;
}

export function jsonWithApiVersion<T>(
  body: T,
  init?: number | ResponseInit,
): NextResponse {
  const status = typeof init === 'number' ? init : (init?.status ?? 200);
  const res = NextResponse.json(body, { ...(typeof init === 'object' ? init : {}), status });
  return withApiVersion(res);
}
