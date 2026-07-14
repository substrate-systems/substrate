import { randomUUID, timingSafeEqual } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { renderExomemMagicLinkEmail } from "@/lib/email-templates/exomem-access";
import {
  claimMagicLinkDelivery,
  expireInvalidMagicLinkDeliveries,
  markMagicLinkDeliverySent,
  releaseMagicLinkDelivery,
  pruneStaleRateLimitBuckets,
  type ClaimedMagicLinkDelivery,
} from "./db";
import {
  exomemPublicBaseUrlFromEnv,
  exomemPublicFragmentUrl,
  parseExomemPublicBaseUrl,
} from "./public-origin";
import { EXOMEM_RATE_LIMIT_RETENTION_SECONDS } from "./rate-limit";
import { decryptSecret, tokenDigest, type SecretEnvelope, type SensitiveSecret } from "./security";

type SendEmail = typeof sendTransactionalEmail;

export type MagicLinkDeliveryDependencies = {
  now: () => Date;
  newLeaseOwner: () => string;
  publicBaseUrl: string;
  pruneRateLimits: (retentionSeconds: number, limit: number) => Promise<number>;
  expireInvalid: (limit?: number) => Promise<number>;
  claim: (input: {
    leaseOwner: string;
    leaseSeconds?: number;
  }) => Promise<ClaimedMagicLinkDelivery | null>;
  markSent: (input: { deliveryId: string; leaseOwner: string }) => Promise<boolean>;
  release: (input: {
    deliveryId: string;
    leaseOwner: string;
    errorCode: string;
    terminal: boolean;
  }) => Promise<"retry" | "failed" | "lost">;
  decrypt: (envelope: SecretEnvelope) => SensitiveSecret;
  sendEmail: SendEmail;
};

function defaults(): MagicLinkDeliveryDependencies {
  return {
    now: () => new Date(),
    newLeaseOwner: randomUUID,
    publicBaseUrl: exomemPublicBaseUrlFromEnv(),
    pruneRateLimits: pruneStaleRateLimitBuckets,
    expireInvalid: expireInvalidMagicLinkDeliveries,
    claim: claimMagicLinkDelivery,
    markSent: markMagicLinkDeliverySent,
    release: releaseMagicLinkDelivery,
    decrypt: (envelope) => decryptSecret(envelope),
    sendEmail: sendTransactionalEmail,
  };
}

function parseDeliveryPayload(
  record: ClaimedMagicLinkDelivery,
  decrypt: MagicLinkDeliveryDependencies["decrypt"],
  now: Date
): { token: string; expiresAt: Date } | null {
  try {
    const raw = decrypt(record.secretCiphertext).reveal();
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      Object.keys(value).sort().join(",") !== "emailNormalized,expiresAt,purpose,token,version" ||
      value.version !== 1 ||
      value.purpose !== "magic_link" ||
      value.emailNormalized !== record.emailNormalized ||
      value.expiresAt !== record.expiresAt ||
      typeof value.token !== "string"
    ) {
      return null;
    }
    const digest = tokenDigest(value.token);
    if (!digest || digest.length !== record.tokenDigest.length) return null;
    if (!timingSafeEqual(digest, record.tokenDigest)) return null;
    const expiresAt = new Date(record.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= now) return null;
    return { token: value.token, expiresAt };
  } catch {
    return null;
  }
}

export async function drainMagicLinkDeliveries(
  options: { maxMessages?: number; timeBudgetMs?: number } = {},
  dependencies?: Partial<MagicLinkDeliveryDependencies>
): Promise<{
  expired: number;
  prunedRateLimits: number;
  claimed: number;
  sent: number;
  retryScheduled: number;
  failed: number;
  lost: number;
}> {
  const deps = { ...defaults(), ...dependencies };
  const maxMessages = Math.max(1, Math.min(options.maxMessages ?? 5, 20));
  const timeBudgetMs = Math.max(250, options.timeBudgetMs ?? 8_000);
  const started = Date.now();
  const leaseOwner = deps.newLeaseOwner();
  const publicBaseUrl = parseExomemPublicBaseUrl(deps.publicBaseUrl);
  const result = {
    prunedRateLimits: await deps.pruneRateLimits(EXOMEM_RATE_LIMIT_RETENTION_SECONDS, 1_000),
    expired: await deps.expireInvalid(100),
    claimed: 0,
    sent: 0,
    retryScheduled: 0,
    failed: 0,
    lost: 0,
  };

  while (result.claimed < maxMessages && Date.now() - started < timeBudgetMs) {
    const record = await deps.claim({ leaseOwner, leaseSeconds: 60 });
    if (!record) break;
    result.claimed += 1;
    const payload = parseDeliveryPayload(record, deps.decrypt, deps.now());
    if (!payload) {
      const state = await deps.release({
        deliveryId: record.deliveryId,
        leaseOwner,
        errorCode: "DELIVERY_PAYLOAD_INVALID",
        terminal: true,
      });
      if (state === "failed") result.failed += 1;
      else if (state === "retry") result.retryScheduled += 1;
      else result.lost += 1;
      continue;
    }

    const rendered = renderExomemMagicLinkEmail({
      accessUrl: exomemPublicFragmentUrl(publicBaseUrl, "/exomem/sign-in", payload.token),
      expiresAt: payload.expiresAt,
    });
    let delivered = false;
    try {
      delivered = (
        await deps.sendEmail({
          to: record.emailNormalized,
          senderName: "Exomem",
          subject: rendered.subject,
          htmlContent: rendered.htmlContent,
          textContent: rendered.textContent,
        })
      ).success;
    } catch {
      delivered = false;
    }
    if (delivered) {
      if (await deps.markSent({ deliveryId: record.deliveryId, leaseOwner })) {
        result.sent += 1;
      } else {
        result.lost += 1;
      }
      continue;
    }
    const state = await deps.release({
      deliveryId: record.deliveryId,
      leaseOwner,
      errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
      terminal: false,
    });
    if (state === "retry") result.retryScheduled += 1;
    else if (state === "failed") result.failed += 1;
    else result.lost += 1;
  }
  return result;
}
