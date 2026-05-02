import type { NextRequest } from 'next/server';
import { verifyAccessToken } from './jwt';
import { errors } from './errors';
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
