import { createHash } from "node:crypto";
import { takeRateLimit as takeRateLimitQuery } from "./db";

export type ExomemRateLimitRule = {
  scope: string;
  limit: number;
  windowSeconds: number;
};

export const EXOMEM_RATE_LIMITS = {
  adminInvites: {
    scope: "exomem:admin-invite",
    limit: 30,
    windowSeconds: 60 * 60,
  },
  magicLinkAccount: {
    scope: "exomem:magic-link:account",
    limit: 5,
    windowSeconds: 60 * 60,
  },
  magicLinkIp: {
    scope: "exomem:magic-link:ip",
    limit: 20,
    windowSeconds: 60 * 60,
  },
} as const satisfies Record<string, ExomemRateLimitRule>;

export function hashRateLimitKey(rule: ExomemRateLimitRule, value: string): string {
  return createHash("sha256").update(`${rule.scope}\0${value}`, "utf8").digest("hex");
}

export async function takeExomemRateLimit(
  rule: ExomemRateLimitRule,
  value: string
): Promise<boolean> {
  return takeRateLimitQuery({
    scope: rule.scope,
    keyDigest: hashRateLimitKey(rule, value),
    limit: rule.limit,
    windowSeconds: rule.windowSeconds,
  });
}

export function clientAddressKey(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}
