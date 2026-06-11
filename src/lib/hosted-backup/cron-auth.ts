import { timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';

/**
 * Vercel cron convention: the platform sets `Authorization: Bearer
 * <CRON_SECRET>` on scheduled invocations. Manual hits without the secret are
 * rejected. Fails closed: when the env var is unset, EVERY request is
 * rejected — including Vercel's own scheduled ones — so a misconfigured
 * deploy can never allow unauthenticated cron runs (it just makes the cron a
 * no-op until the secret is installed; see
 * docs/runbooks/production-keys-and-storage.md).
 */
export function verifyCronAuth(req: NextRequest): { ok: boolean } {
  const expected = process.env.CRON_SECRET;
  if (!expected) return { ok: false };
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) return { ok: false };
  if (!header.toLowerCase().startsWith('bearer ')) return { ok: false };
  const provided = header.slice('bearer '.length).trim();
  // Constant-time compare; timingSafeEqual throws on length mismatch, so
  // gate on length first (length itself is not secret).
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return { ok: a.length === b.length && timingSafeEqual(a, b) };
}
