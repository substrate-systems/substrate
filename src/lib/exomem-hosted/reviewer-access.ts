import argon2 from "argon2";
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { exomemErrors } from "./errors";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit, type ExomemRateLimitRule } from "./rate-limit";
import type { RandomBytesSource } from "./security";

export type MarketplaceReviewerProvider = "openai" | "anthropic";

export type MarketplaceReviewerCredential = {
  username: string;
  password: string;
  usernameDigest: Buffer;
};

export type MarketplaceReviewerAuthentication = {
  credentialId: string;
  provider: MarketplaceReviewerProvider;
  ownerUserId: string;
  tenantId: string;
  fixtureVersion: string;
};

export type MarketplaceReviewerAuthenticationRecord = MarketplaceReviewerAuthentication & {
  passwordHash: string;
  expiresAt: string;
  revokedAt: string | null;
};

const REVIEWER_PASSWORD_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

// This is a fixed Argon2id PHC value for a non-secret sentinel. Every failed
// lookup verifies it so unknown usernames follow the same expensive shape.
const DUMMY_REVIEWER_PASSWORD_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$zstYSQCal+mlPtTH46Ukag$MeE900hE+XoluBd9hFOsxpFB3bgI+RlM+lUOuxMNsIE";
const MAX_REVIEWER_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function opaqueToken(randomBytes: RandomBytesSource): string {
  const bytes = randomBytes(32);
  if (bytes.length < 32) throw new Error("reviewer credential entropy is unavailable");
  return Buffer.from(bytes).subarray(0, 32).toString("base64url");
}

export function normalizeMarketplaceReviewerUsername(value: string): string {
  return value.trim().toLowerCase();
}

export function reviewerUsernameDigest(value: string): Buffer {
  return createHash("sha256").update(normalizeMarketplaceReviewerUsername(value), "utf8").digest();
}

export function generateMarketplaceReviewerCredential(
  input: { randomBytes?: RandomBytesSource } = {}
): MarketplaceReviewerCredential {
  const randomBytes = input.randomBytes ?? nodeRandomBytes;
  const username = `exr_${opaqueToken(randomBytes)}`;
  const password = opaqueToken(randomBytes);
  return { username, password, usernameDigest: reviewerUsernameDigest(username) };
}

export async function hashMarketplaceReviewerPassword(password: string): Promise<string> {
  return argon2.hash(Buffer.from(password, "utf8"), REVIEWER_PASSWORD_OPTIONS);
}

export async function verifyMarketplaceReviewerPassword(
  passwordHash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(passwordHash, Buffer.from(password, "utf8"));
  } catch {
    return false;
  }
}

export function marketplaceReviewerAccessEnabled(
  environment: Record<string, string | undefined> = process.env
): boolean {
  return environment.EXOMEM_MARKETPLACE_REVIEWER_ACCESS_ENABLED?.trim().toLowerCase() === "true";
}

export function validateMarketplaceReviewerExpiry(expiresAt: Date, now = new Date()): void {
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() - now.getTime() > MAX_REVIEWER_CREDENTIAL_TTL_MS
  ) {
    throw exomemErrors.invalidExpiry();
  }
}

type ReviewerRateLimit = (
  rule: ExomemRateLimitRule,
  value: string
) => Promise<boolean>;

export async function authenticateMarketplaceReviewerCredential(
  input: { username: string; password: string; clientAddress: string },
  dependencies: {
    enabled?: boolean;
    lookup: (usernameDigest: Buffer) => Promise<MarketplaceReviewerAuthenticationRecord | null>;
    takeRateLimit?: ReviewerRateLimit;
    now?: Date;
  }
): Promise<MarketplaceReviewerAuthentication | null> {
  if (dependencies.enabled !== true) return null;

  const rateLimit = dependencies.takeRateLimit ?? takeExomemRateLimit;
  const username = normalizeMarketplaceReviewerUsername(input.username);
  let allowed: boolean;
  try {
    allowed = await rateLimit(EXOMEM_RATE_LIMITS.marketplaceReviewerIp, input.clientAddress);
    if (!allowed) return null;
    allowed = await rateLimit(EXOMEM_RATE_LIMITS.marketplaceReviewerUsername, username);
    if (!allowed) return null;
  } catch {
    return null;
  }

  const digest = reviewerUsernameDigest(username);
  let record: MarketplaceReviewerAuthenticationRecord | null;
  try {
    record = await dependencies.lookup(digest);
  } catch {
    return null;
  }
  const passwordMatches = await verifyMarketplaceReviewerPassword(
    record?.passwordHash ?? DUMMY_REVIEWER_PASSWORD_HASH,
    input.password
  );
  if (!record || !passwordMatches || record.revokedAt || new Date(record.expiresAt) <= (dependencies.now ?? new Date())) {
    return null;
  }
  return {
    credentialId: record.credentialId,
    provider: record.provider,
    ownerUserId: record.ownerUserId,
    tenantId: record.tenantId,
    fixtureVersion: record.fixtureVersion,
  };
}
