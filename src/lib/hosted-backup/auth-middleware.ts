import type { NextRequest } from 'next/server';
import { verifyAccessToken } from './jwt';
import { errors } from './errors';
import { getSubscriptionStatus } from './db';
import type { SubscriptionStatus } from './types';

export type AuthContext = {
  userId: string;
  subscriptionStatus: SubscriptionStatus;
  jti: string;
};

export async function requireAuth(req: NextRequest): Promise<AuthContext> {
  const header =
    req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) throw errors.unauthenticated();
  const lower = header.toLowerCase();
  if (!lower.startsWith('bearer ')) {
    throw errors.unauthenticated('expected Bearer token');
  }
  const token = header.slice('bearer '.length).trim();
  if (!token) throw errors.unauthenticated('empty Bearer token');
  const claims = await verifyAccessToken(token);
  return {
    userId: claims.userId,
    subscriptionStatus: claims.subscriptionStatus,
    jti: claims.jti,
  };
}

/**
 * Auth + write-access gate. Re-reads subscription status from DB rather than
 * trusting the JWT claim (which is a hint with up to 15-min staleness per
 * contract §10). Allows only `active`.
 */
export async function requireWriteAccess(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  const live = await getSubscriptionStatus(ctx.userId);
  if (live !== 'active') {
    throw errors.subscriptionRequired(
      live === 'none'
        ? 'an active subscription is required'
        : `writes are blocked while subscription is ${live}`,
    );
  }
  return { ...ctx, subscriptionStatus: live };
}

/**
 * Auth + read-access gate. Allows `active`, `grace`, `cancelled`. Blocks
 * `none`. Re-reads subscription status from DB.
 */
export async function requireReadAccess(req: NextRequest): Promise<AuthContext> {
  const ctx = await requireAuth(req);
  const live = await getSubscriptionStatus(ctx.userId);
  if (live === 'none') {
    throw errors.subscriptionRequired('no subscription on file');
  }
  return { ...ctx, subscriptionStatus: live };
}
