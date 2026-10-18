import { EXOMEM_THEME_CHOICES, type ExomemThemeChoice } from "@/lib/exomem/theme";
import { z } from "zod";
import { after, NextResponse } from "next/server";
import { EXOMEM_EMAIL_SCHEMES, type ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
import { requestStart } from "./access";
import { dispatchMagicLinkDelivery, type MagicLinkDeliveryState } from "./access-delivery";
import { executeExomemSql } from "./db";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import { EXOMEM_RATE_LIMITS, hashRateLimitKey } from "./rate-limit";
import {
  cookieValue,
  EXOMEM_ACCESS_RECOVERY_COOKIE,
  applyMagicLinkChallengeCookie,
  magicLinkChallengeFromRequest,
  mintMagicLinkChallenge,
} from "./sessions";
import { clientAddressKey } from "./rate-limit";
import {
  decryptSecret,
  encryptSecret,
  generateExternalToken,
  tokenDigest,
  type SecretEnvelope,
} from "./security";

const Receipt = z
  .object({
    purpose: z.literal("access_recovery"),
    version: z.literal(1),
    email: z.string().max(254),
    timeZone: z.string().max(128).nullable(),
    // Optional: a receipt minted before the scheme travelled has none.
    emailScheme: z.enum(EXOMEM_EMAIL_SCHEMES).nullable().optional(),
    themeChoice: z.enum(EXOMEM_THEME_CHOICES).nullable().optional(),
    browserKey: z.string().length(43),
    expiresAt: z.iso.datetime(),
    // A SHA-256 digest has this fixed hexadecimal field format.
    challengeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
// Recovery is a resend capability; its configured lifetime cannot exceed one day.
const MAX_RECOVERY_TTL_SECONDS = 24 * 60 * 60;
export type AccessRecoveryReceipt = z.infer<typeof Receipt>;

export function readAccessRecoveryReceipt(
  request: Request,
  now = new Date()
): AccessRecoveryReceipt | null {
  const raw = cookieValue(request, EXOMEM_ACCESS_RECOVERY_COOKIE);
  if (!raw || raw.length > 2048) return null;
  try {
    const envelope = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as SecretEnvelope;
    const receipt = Receipt.parse(JSON.parse(decryptSecret(envelope).reveal()));
    const remaining = Date.parse(receipt.expiresAt) - now.getTime();
    return remaining > 0 &&
      remaining <= MAX_RECOVERY_TTL_SECONDS * 1000 &&
      tokenDigest(receipt.browserKey)
      ? receipt
      : null;
  } catch {
    return null;
  }
}

/** The opaque receipt survives authentication expiry and authorizes only resend to the submitted address. */
export function mintAccessRecoveryReceipt(
  input: {
    email: string;
    timeZone: string | null;
    emailScheme: ExomemEmailScheme | null;
    themeChoice?: ExomemThemeChoice | null;
    challengeDigest: Buffer;
    prior: AccessRecoveryReceipt | null;
    /** A resend passed no bot check, so it keeps the prior expiry: one check never buys resends forever. */
    resend?: boolean;
  },
  now = new Date()
) {
  const ttl = z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_RECOVERY_TTL_SECONDS)
    .parse(process.env.EXOMEM_ACCESS_RECOVERY_TTL_SECONDS ?? 3600);
  const receipt: AccessRecoveryReceipt = {
    purpose: "access_recovery",
    version: 1,
    email: input.email.trim().length <= 254 ? input.email.trim() : "",
    timeZone: input.timeZone,
    emailScheme: input.emailScheme,
    themeChoice: input.themeChoice,
    browserKey: input.prior?.browserKey ?? generateExternalToken(),
    challengeDigest: input.challengeDigest.toString("hex"),
    expiresAt:
      input.resend && input.prior
        ? input.prior.expiresAt
        : new Date(now.getTime() + ttl * 1000).toISOString(),
  };
  return {
    receipt,
    token: Buffer.from(JSON.stringify(encryptSecret(JSON.stringify(receipt)))).toString(
      "base64url"
    ),
    // The cookie lasts as long as the receipt it carries.
    ttl: Math.max(1, Math.ceil((Date.parse(receipt.expiresAt) - now.getTime()) / 1000)),
  };
}

function applyAccessRecoveryCookie(
  response: NextResponse,
  material: ReturnType<typeof mintAccessRecoveryReceipt>
) {
  response.cookies.set(EXOMEM_ACCESS_RECOVERY_COOKIE, material.token, {
    secure: process.env.NODE_ENV === "production",
    httpOnly: true,
    sameSite: "lax",
    path: "/api/exomem/access",
    expires: new Date(material.receipt.expiresAt),
    maxAge: material.ttl,
  });
}

/** A link can name its failure only after its original browser receipt proves the binding. */
export async function recoveryLinkState(
  receipt: AccessRecoveryReceipt,
  token: string
): Promise<"expired" | "used" | null> {
  const digest = tokenDigest(token);
  if (!digest) return null;
  const { rows } = await executeExomemSql`
    SELECT CASE WHEN consumed_at IS NOT NULL THEN 'used'
                WHEN expires_at <= now() OR revoked_at IS NOT NULL THEN 'expired'
                ELSE NULL END AS state
    FROM exomem_access_tokens
    WHERE token_digest = ${digest}
      AND browser_challenge_digest = ${Buffer.from(receipt.challengeDigest, "hex")}
      AND purpose = 'magic_link'
  `;
  const state = rows[0]?.state;
  return state === "expired" || state === "used" ? state : null;
}

/** Only browser/IP buckets determine a visible wait; email suppression has no observable timing. */
export async function accessStartRetryAfterSeconds(
  browserKey: string,
  networkKey: string
): Promise<number> {
  const browser = EXOMEM_RATE_LIMITS.startBrowser;
  const ip = EXOMEM_RATE_LIMITS.startIp;
  const { rows } = await executeExomemSql`
    SELECT COALESCE(MAX(GREATEST(0, CEIL(EXTRACT(EPOCH FROM
      (window_started_at + window_seconds * interval '1 second' - now()))))), 0)::int AS seconds
    FROM (
      SELECT window_started_at, ${browser.windowSeconds}::int AS window_seconds
      FROM exomem_rate_limit_buckets
      WHERE scope = ${browser.scope} AND key_digest = ${hashRateLimitKey(browser, browserKey)} AND admitted_count >= ${browser.limit}
      UNION ALL
      SELECT window_started_at, ${ip.windowSeconds}::int AS window_seconds
      FROM exomem_rate_limit_buckets
      WHERE scope = ${ip.scope} AND key_digest = ${hashRateLimitKey(ip, networkKey)} AND admitted_count >= ${ip.limit}
    ) AS common_limits
  `;
  return Number(rows[0].seconds);
}

/**
 * Start and recovery share one public answer; only common limits can change its visible wait.
 * `resend` is the recovery route's resend, which passed no bot check of its own.
 */
export async function uniformAccessStartResponse(
  request: Request,
  input: {
    email: string;
    timeZone: string | null;
    emailScheme: ExomemEmailScheme | null;
    themeChoice?: ExomemThemeChoice | null;
    requestId: string;
    resend: boolean;
  }
) {
  const prior = readAccessRecoveryReceipt(request);
  let challenge = mintMagicLinkChallenge();
  let recovery = mintAccessRecoveryReceipt({
    email: input.email,
    timeZone: input.timeZone,
    emailScheme: input.emailScheme,
    themeChoice: input.themeChoice,
    challengeDigest: challenge.challengeDigest,
    prior,
    resend: input.resend,
  });
  const networkKey = clientAddressKey(request) ?? "unavailable";
  const retryLimited =
    (await accessStartRetryAfterSeconds(recovery.receipt.browserKey, networkKey)) > 0;
  if (retryLimited && prior) {
    // A common cooldown must not invalidate the newest link that is already in the browser's email.
    recovery = mintAccessRecoveryReceipt({
      email: prior.email,
      timeZone: prior.timeZone,
      emailScheme: prior.emailScheme ?? null,
      themeChoice: prior.themeChoice ?? null,
      challengeDigest: Buffer.from(prior.challengeDigest, "hex"),
      prior,
      resend: input.resend,
    });
    const existing = magicLinkChallengeFromRequest(request);
    const digest = existing ? tokenDigest(existing) : null;
    if (existing && digest?.toString("hex") === prior.challengeDigest)
      challenge = { ...challenge, challengeToken: existing, challengeDigest: digest };
  }
  const { deliveryId } = await requestStart({
    email: recovery.receipt.email,
    timeZone: recovery.receipt.timeZone,
    emailScheme: recovery.receipt.emailScheme ?? null,
    themeChoice: recovery.receipt.themeChoice ?? null,
    browserChallengeDigest: challenge.challengeDigest,
    browserKey: recovery.receipt.browserKey,
    networkKey,
  });
  if (deliveryId) scheduleMagicLinkDelivery(deliveryId, input.requestId);
  const retryAfterSeconds = await accessStartRetryAfterSeconds(
    recovery.receipt.browserKey,
    networkKey
  );
  const response = NextResponse.json(
    {
      success: true,
      status: "if_eligible_email_sent",
      retryAfterSeconds,
      retryLimited,
      requestId: input.requestId,
    },
    { status: 202, headers: { "cache-control": "no-store" } }
  );
  applyMagicLinkChallengeCookie(response, challenge);
  applyAccessRecoveryCookie(response, recovery);
  return response;
}

/**
 * Logs, content-free and under the request's id, what became of the link sent
 * right after the request. A retry waits for the scheduled drain, whose route
 * logs its own counts. "lost" logs nothing: the lease ran out, so the row is the
 * drain's again, though a slow provider may still have taken this send.
 */
function reportMagicLinkDelivery(state: MagicLinkDeliveryState | null, requestId: string) {
  if (state === "sent") {
    emitOperationalEvent(
      buildOperationalEvent({ event: "access.magic_link.sent", outcome: "succeeded", requestId })
    );
  } else if (state === "retry" || state === "failed") {
    emitOperationalEvent(
      buildOperationalEvent({
        event: "access.magic_link.delivery_failed",
        outcome: state === "retry" ? "pending" : "failed",
        errorCode: state === "retry" ? "EMAIL_DELIVERY_UNAVAILABLE" : "EMAIL_DELIVERY_FAILED",
        requestId,
      })
    );
  }
}

/** The row is durable before registration; cron recovers a failed hook or invocation. */
function scheduleMagicLinkDelivery(deliveryId: string, requestId: string): void {
  try {
    after(async () => {
      try {
        reportMagicLinkDelivery(await dispatchMagicLinkDelivery(deliveryId), requestId);
      } catch {
        emitOperationalEvent(
          buildOperationalEvent({
            event: "access.magic_link.delivery_failed",
            outcome: "failed",
            errorCode: "INTERNAL_ERROR",
            requestId,
          })
        );
      }
    });
  } catch {
    emitOperationalEvent(
      buildOperationalEvent({
        event: "access.magic_link.delivery_failed",
        outcome: "failed",
        errorCode: "NOTIFICATION_NOT_SCHEDULED",
        requestId,
      })
    );
  }
}
