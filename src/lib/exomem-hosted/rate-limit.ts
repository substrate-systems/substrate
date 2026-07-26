import { createHmac } from "node:crypto";
import { takeRateLimit as takeRateLimitQuery } from "./db";
import { controlPlaneKeyFromEnv } from "./security";

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
  oauthAuthorizeIp: {
    scope: "exomem:oauth-authorize:ip",
    limit: 60,
    windowSeconds: 10 * 60,
  },
  oauthAuthorizeClient: {
    scope: "exomem:oauth-authorize:client",
    limit: 120,
    windowSeconds: 10 * 60,
  },
  mcpIp: {
    scope: "exomem:mcp:ip",
    limit: 120,
    windowSeconds: 60,
  },
  mcpIdentity: {
    scope: "exomem:mcp:identity",
    limit: 300,
    windowSeconds: 60,
  },
  deletionConfirmation: {
    scope: "exomem:deletion-confirmation",
    limit: 3,
    windowSeconds: 60 * 60,
  },
} as const satisfies Record<string, ExomemRateLimitRule>;

const MAX_RATE_LIMIT_WINDOW_SECONDS = Math.max(
  ...Object.values(EXOMEM_RATE_LIMITS).map((rule) => rule.windowSeconds)
);
export const EXOMEM_RATE_LIMIT_RETENTION_MARGIN_SECONDS = 60 * 60;
export const EXOMEM_RATE_LIMIT_RETENTION_SECONDS =
  MAX_RATE_LIMIT_WINDOW_SECONDS + EXOMEM_RATE_LIMIT_RETENTION_MARGIN_SECONDS;

export function hashRateLimitKey(
  rule: ExomemRateLimitRule,
  value: string,
  key: Buffer = controlPlaneKeyFromEnv()
): string {
  return createHmac("sha256", key)
    .update("exomem-rate-limit:v1\0", "utf8")
    .update(rule.scope, "utf8")
    .update("\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export async function takeExomemRateLimit(
  rule: ExomemRateLimitRule,
  value: string,
  dependencies: {
    key?: Buffer;
    take?: typeof takeRateLimitQuery;
  } = {}
): Promise<boolean> {
  return (dependencies.take ?? takeRateLimitQuery)({
    scope: rule.scope,
    keyDigest: hashRateLimitKey(rule, value, dependencies.key),
    limit: rule.limit,
    windowSeconds: rule.windowSeconds,
  });
}

export function clientAddressKey(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || null;
}
