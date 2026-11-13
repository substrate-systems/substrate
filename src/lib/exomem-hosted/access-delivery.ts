import { exomemThemeChoice, type ExomemThemeChoice } from "@/lib/exomem/theme";
import { normalizeTimeZone } from "./time-zone";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { EXOMEM_SENDER } from "@/lib/exomem-hosted/mail-sender";
import { renderExomemMagicLinkEmail } from "@/lib/email-templates/exomem-access";
import { exomemEmailScheme, type ExomemEmailScheme } from "@/lib/email-templates/exomem-email";
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
import { normalizeProviderMessageId } from "./email-provider-events";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
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
    deliveryId?: string;
  }) => Promise<ClaimedMagicLinkDelivery | null>;
  markSent: (input: {
    deliveryId: string;
    leaseOwner: string;
    providerMessageId?: string | null;
  }) => Promise<boolean>;
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
): {
  token: string;
  expiresAt: Date;
  timeZone: string | null;
  emailScheme: ExomemEmailScheme | null;
  themeChoice?: ExomemThemeChoice | null;
} | null {
  try {
    const raw = decrypt(record.secretCiphertext).reveal();
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (
      // These keys are the encrypted delivery schema, including the optional fallback
      // zone and scheme.
      Object.keys(value).some(
        (key) =>
          ![
            "emailNormalized",
            "expiresAt",
            "purpose",
            "token",
            "version",
            "timeZone",
            "emailScheme",
            "themeChoice",
          ].includes(key)
      ) ||
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
    return {
      token: value.token,
      expiresAt,
      timeZone: normalizeTimeZone(value.timeZone),
      emailScheme: exomemEmailScheme(value.emailScheme),
      themeChoice: exomemThemeChoice(value.themeChoice),
    };
  } catch {
    return null;
  }
}

/** What became of one claimed sign-in link. "lost": this worker no longer holds the row. */
export type MagicLinkDeliveryState = "sent" | "retry" | "failed" | "lost";

/**
 * Logs, content-free, what became of one claimed link, whoever claimed it: the
 * request's dispatch, under its id, or the drain. "lost" logs nothing: the
 * lease ran out, so the row is the drain's again, though a slow provider may
 * still have taken this send.
 */
function reportMagicLinkSettled(
  state: MagicLinkDeliveryState,
  detail: { attempts: number; queueMs: number; errorCode: string; requestId?: string }
): void {
  const base = { emailKind: "magic_link", requestId: detail.requestId };
  if (state === "sent") {
    emitOperationalEvent(
      buildOperationalEvent({
        event: "access.magic_link.sent",
        outcome: "succeeded",
        attempts: detail.attempts,
        queueMs: detail.queueMs,
        ...base,
      })
    );
  } else if (state === "retry" || state === "failed") {
    emitOperationalEvent(
      buildOperationalEvent({
        event: "access.magic_link.delivery_failed",
        outcome: state === "retry" ? "pending" : "failed",
        errorCode: detail.errorCode,
        ...base,
      })
    );
  }
}

async function deliverClaimedMagicLink(
  record: ClaimedMagicLinkDelivery,
  leaseOwner: string,
  publicBaseUrl: ReturnType<typeof parseExomemPublicBaseUrl>,
  deps: MagicLinkDeliveryDependencies,
  requestId?: string
): Promise<MagicLinkDeliveryState> {
  const settled = async (
    state: MagicLinkDeliveryState,
    errorCode: string
  ): Promise<MagicLinkDeliveryState> => {
    reportMagicLinkSettled(state, {
      attempts: record.attempts,
      queueMs: Math.max(0, deps.now().getTime() - Date.parse(record.createdAt)),
      errorCode,
      requestId,
    });
    return state;
  };
  const payload = parseDeliveryPayload(record, deps.decrypt, deps.now());
  if (!payload) {
    return settled(
      await deps.release({
        deliveryId: record.deliveryId,
        leaseOwner,
        errorCode: "DELIVERY_PAYLOAD_INVALID",
        terminal: true,
      }),
      "DELIVERY_PAYLOAD_INVALID"
    );
  }

  const rendered = renderExomemMagicLinkEmail({
    accessUrl: exomemPublicFragmentUrl(publicBaseUrl, "/exomem/sign-in", payload.token),
    expiresAt: payload.expiresAt,
    timeZone: record.recipientTimeZone ?? payload.timeZone,
    // The page that asked for the link decides: a scheme changes only how the email
    // looks, so this one email may follow a request that has not signed in yet.
    scheme: payload.emailScheme ?? record.recipientEmailScheme,
    themeChoice: payload.themeChoice,
  });
  let answer: Awaited<ReturnType<SendEmail>> | null = null;
  try {
    answer = await deps.sendEmail({
      to: record.emailNormalized,
      ...EXOMEM_SENDER,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
  } catch {
    answer = null;
  }
  if (answer?.success) {
    const recorded = await deps.markSent({
      deliveryId: record.deliveryId,
      leaseOwner,
      providerMessageId: normalizeProviderMessageId(answer.messageId),
    });
    return settled(recorded ? "sent" : "lost", "EMAIL_DELIVERY_UNAVAILABLE");
  }
  return settled(
    await deps.release({
      deliveryId: record.deliveryId,
      leaseOwner,
      errorCode: "EMAIL_DELIVERY_UNAVAILABLE",
      terminal: false,
    }),
    "EMAIL_DELIVERY_UNAVAILABLE"
  );
}

/**
 * Claim only this request's durable row; the scheduled drain owns backlog maintenance.
 * Null when the row is not this request's to send: the drain holds it or it is settled.
 */
export async function dispatchMagicLinkDelivery(
  deliveryId: string,
  dependencies?: Partial<MagicLinkDeliveryDependencies>,
  requestId?: string
): Promise<MagicLinkDeliveryState | null> {
  const deps = { ...defaults(), ...dependencies };
  const leaseOwner = deps.newLeaseOwner();
  const publicBaseUrl = parseExomemPublicBaseUrl(deps.publicBaseUrl);
  const record = await deps.claim({ deliveryId, leaseOwner, leaseSeconds: 60 });
  return record
    ? deliverClaimedMagicLink(record, leaseOwner, publicBaseUrl, deps, requestId)
    : null;
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
    const state = await deliverClaimedMagicLink(record, leaseOwner, publicBaseUrl, deps);
    if (state === "retry") result.retryScheduled += 1;
    else result[state] += 1;
  }
  return result;
}
