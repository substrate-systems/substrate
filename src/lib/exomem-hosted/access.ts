import { randomBytes as nodeRandomBytes } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { EXOMEM_SENDER } from "@/lib/exomem-hosted/mail-sender";
import { renderExomemInviteEmail } from "@/lib/email-templates/exomem-access";
import {
  createInviteRecord,
  createMagicAccessToken,
  markInviteDelivered,
  markInviteDeliveryFailed,
  inspectValidInvite,
  redeemMagicAccessTokenAtomic,
  type CreateInviteRecordInput,
  type CreateMagicAccessTokenInput,
  type RedeemMagicAccessTokenInput,
  type RedeemedAccess,
} from "./db";
import { exomemErrors } from "./errors";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import {
  exomemPublicBaseUrlFromEnv,
  exomemPublicFragmentUrl,
  parseExomemPublicBaseUrl,
} from "./public-origin";
import { EXOMEM_RATE_LIMITS, normalizedEmailRateLimitKey, takeExomemRateLimit } from "./rate-limit";
import {
  EXOMEM_INVITE_CAPABILITIES,
  EXOMEM_INVITE_LIMITS,
  selfServeAdmissionMode,
  startSelfServeAtomic,
  type SelfServeAdmissionMode,
  type StartOutcome,
} from "./self-serve-admission";
import { mintSessionMaterial, type SessionMaterial } from "./sessions";
import {
  encryptSecret,
  generateExternalToken,
  tokenDigest,
  type RandomBytesSource,
  type SecretEnvelope,
} from "./security";

const EMAIL = /^[^\s<>"'`&]+@[^\s<>"'`&]+\.[^\s<>"'`&]+$/;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every start request that passed the bot check takes at least this long,
 * whatever its outcome, so its timing does not tell whether the address owns
 * an Exomem, was admitted or was queued.
 */
const START_RESPONSE_FLOOR_MS = 600;

type SendEmail = typeof sendTransactionalEmail;

export type AccessDependencies = {
  now: () => Date;
  randomBytes: RandomBytesSource;
  publicBaseUrl: string;
  createInvite: (input: CreateInviteRecordInput) => Promise<{ inviteId: string }>;
  markInviteDelivered: (inviteId: string) => Promise<void>;
  markInviteDeliveryFailed: (inviteId: string, errorCode: string) => Promise<void>;
  inspectInvite: typeof inspectValidInvite;
  admissionMode: () => SelfServeAdmissionMode;
  startSelfServe: (input: {
    emailNormalized: string;
    timeZone: string | null;
    mode: "waitlist" | "open";
  }) => Promise<StartOutcome>;
  createMagicAccessToken: (
    input: CreateMagicAccessTokenInput
  ) => Promise<{ tokenId: string; emailNormalized?: string } | null>;
  encryptDeliverySecret: (value: string) => SecretEnvelope;
  redeemMagicAccessTokenAtomic: (
    input: RedeemMagicAccessTokenInput
  ) => Promise<RedeemedAccess | null>;
  sendEmail: SendEmail;
  takeRateLimit: (
    rule: (typeof EXOMEM_RATE_LIMITS)[keyof typeof EXOMEM_RATE_LIMITS],
    value: string
  ) => Promise<boolean>;
  /** Waits out the rest of the response floor, from a `performance.now()` start. */
  completeStartRequest: (startedAtMs: number) => Promise<void>;
};

async function padStartResponse(startedAtMs: number): Promise<void> {
  const elapsedMs = performance.now() - startedAtMs;
  const remainingMs = START_RESPONSE_FLOOR_MS - elapsedMs;
  if (remainingMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, remainingMs));
    return;
  }
  // An overrun is the one case where timing can still differ by outcome, so
  // it is recorded, content-free, to show whether the floor needs raising.
  emitOperationalEvent(
    buildOperationalEvent({
      event: "access.start.floor_overrun",
      outcome: "succeeded",
      durationBucket: elapsedMs < 1_000 ? "lt_1s" : elapsedMs < 3_000 ? "lt_3s" : "ge_3s",
    })
  );
}

function defaults(): AccessDependencies {
  return {
    now: () => new Date(),
    randomBytes: nodeRandomBytes,
    publicBaseUrl: exomemPublicBaseUrlFromEnv(),
    createInvite: createInviteRecord,
    markInviteDelivered,
    markInviteDeliveryFailed,
    inspectInvite: inspectValidInvite,
    admissionMode: () => selfServeAdmissionMode(),
    startSelfServe: (input) => startSelfServeAtomic(input),
    createMagicAccessToken,
    encryptDeliverySecret: (value) => encryptSecret(value),
    redeemMagicAccessTokenAtomic,
    sendEmail: sendTransactionalEmail,
    takeRateLimit: takeExomemRateLimit,
    completeStartRequest: padStartResponse,
  };
}

function withDefaults(dependencies?: Partial<AccessDependencies>): AccessDependencies {
  return { ...defaults(), ...dependencies };
}

export function normalizeAccessEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length === 0 || normalized.length > 254 || !EMAIL.test(normalized)) {
    throw exomemErrors.invalidEmail();
  }
  return normalized;
}

export async function issueOperatorInvite(
  input: {
    email: string;
    source: "complimentary" | "paid";
    marketplaceReviewerPurpose?: boolean;
    expiresAt: Date;
    operatorPrincipalDigest: Buffer;
  },
  dependencies?: Partial<AccessDependencies>
): Promise<{ inviteId: string; delivery: "sent" }> {
  const deps = withDefaults(dependencies);
  const emailNormalized = normalizeAccessEmail(input.email);
  const now = deps.now();
  if (
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= now ||
    input.expiresAt.getTime() - now.getTime() > MAX_INVITE_TTL_MS
  ) {
    throw exomemErrors.invalidExpiry();
  }
  if (input.source !== "complimentary" && input.source !== "paid") {
    throw exomemErrors.invalidEntitlementSource();
  }
  const publicBaseUrl = parseExomemPublicBaseUrl(deps.publicBaseUrl);

  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const { inviteId } = await deps.createInvite({
    tokenDigest: digest,
    emailNormalized,
    entitlementSource: input.source === "complimentary" ? "complimentary" : "paddle",
    capabilities: EXOMEM_INVITE_CAPABILITIES,
    resourceLimits: EXOMEM_INVITE_LIMITS,
    marketplaceReviewerPurpose: input.marketplaceReviewerPurpose === true,
    operatorPrincipalDigest: input.operatorPrincipalDigest,
    expiresAt: input.expiresAt,
  });

  const accessUrl = exomemPublicFragmentUrl(publicBaseUrl, "/exomem/invite", token);
  const rendered = renderExomemInviteEmail({
    accessUrl,
    expiresAt: input.expiresAt,
    email: emailNormalized,
  });
  let delivery: Awaited<ReturnType<SendEmail>>;
  try {
    delivery = await deps.sendEmail({
      to: emailNormalized,
      ...EXOMEM_SENDER,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
  } catch {
    delivery = { success: false };
  }
  if (!delivery.success) {
    await deps.markInviteDeliveryFailed(inviteId, "EMAIL_DELIVERY_UNAVAILABLE");
    throw exomemErrors.emailDeliveryUnavailable();
  }
  await deps.markInviteDelivered(inviteId);
  return { inviteId, delivery: "sent" };
}

export async function inspectInvite(
  token: string,
  dependencies?: Partial<AccessDependencies>
): Promise<{ email: string; expiresAt: string }> {
  const deps = withDefaults(dependencies);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const invite = await deps.inspectInvite(digest);
  if (!invite) throw exomemErrors.accessTokenInvalid();
  return {
    email: invite.emailNormalized,
    expiresAt: invite.expiresAt,
  };
}

/**
 * Queues a sign-in link (email 01) for the owner of an Exomem. Returns
 * `false`, having written nothing, when the address owns none.
 */
async function queueOwnerSignInLink(
  deps: AccessDependencies,
  emailNormalized: string,
  browserChallengeDigest: Buffer
): Promise<boolean> {
  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const expiresAt = new Date(deps.now().getTime() + MAGIC_LINK_TTL_MS);
  const deliverySecretCiphertext = deps.encryptDeliverySecret(
    JSON.stringify({
      version: 1,
      purpose: "magic_link",
      emailNormalized,
      token,
      expiresAt: expiresAt.toISOString(),
    })
  );
  const created = await deps.createMagicAccessToken({
    emailNormalized,
    tokenDigest: digest,
    browserChallengeDigest,
    expiresAt,
    deliverySecretCiphertext,
  });
  return created !== null;
}

/**
 * "Start with your email", after the bot check has passed: one request for
 * new and returning people. The caller always answers the same way, and the
 * email carries the outcome:
 *
 * - an owner of an Exomem gets a sign-in link (email 01);
 * - anybody else follows `EXOMEM_SELF_SERVE_ADMISSION`: nothing while it is
 *   `closed`, otherwise a start link or a waitlist place (see
 *   `startSelfServeAtomic`).
 *
 * The two rate limits run before any branch, so a limited request does the
 * same work whoever it names. No branch sends mail itself: each writes an
 * outbox row in the transaction that records its outcome. The response is
 * held to `START_RESPONSE_FLOOR_MS`.
 *
 * A failure inside a branch is logged content-free and still answers
 * "accepted", because a failure status from one branch only would tell the
 * caller which branch ran. A failure of the rate-limit store comes before
 * any branch and fails every request alike, so it is thrown.
 */
export async function requestStart(
  input: {
    email: string;
    networkKey: string;
    browserChallengeDigest: Buffer;
    timeZone: string | null;
  },
  dependencies?: Partial<AccessDependencies>
): Promise<{ accepted: true }> {
  const deps = withDefaults(dependencies);
  const startedAtMs = performance.now();
  try {
    const networkAllowed = await deps.takeRateLimit(EXOMEM_RATE_LIMITS.startIp, input.networkKey);
    if (!networkAllowed) return { accepted: true };
    const addressAllowed = await deps.takeRateLimit(
      EXOMEM_RATE_LIMITS.startEmail,
      normalizedEmailRateLimitKey(input.email)
    );
    if (!addressAllowed) return { accepted: true };

    let emailNormalized: string;
    try {
      emailNormalized = normalizeAccessEmail(input.email);
    } catch {
      return { accepted: true };
    }

    try {
      if (await queueOwnerSignInLink(deps, emailNormalized, input.browserChallengeDigest)) {
        return { accepted: true };
      }
      const mode = deps.admissionMode();
      if (mode === "closed") return { accepted: true };
      await deps.startSelfServe({ emailNormalized, timeZone: input.timeZone, mode });
    } catch {
      emitOperationalEvent(
        buildOperationalEvent({
          event: "access.start.failed",
          outcome: "failed",
          errorCode: "INTERNAL_ERROR",
        })
      );
    }
    return { accepted: true };
  } finally {
    await deps.completeStartRequest(startedAtMs);
  }
}

export async function redeemMagicLink(
  input: { token: string; browserChallenge: string; timeZone?: string | null },
  dependencies?: Partial<AccessDependencies>
): Promise<RedeemedAccess & SessionMaterial> {
  const deps = withDefaults(dependencies);
  const digest = tokenDigest(input.token);
  const browserChallengeDigest = tokenDigest(input.browserChallenge);
  if (!digest || !browserChallengeDigest) throw exomemErrors.accessTokenInvalid();
  const session = mintSessionMaterial({
    now: deps.now(),
    randomBytes: deps.randomBytes,
  });
  const row = await deps.redeemMagicAccessTokenAtomic({
    tokenDigest: digest,
    browserChallengeDigest,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
    timeZone: input.timeZone ?? null,
  });
  if (!row) throw exomemErrors.accessTokenInvalid();
  return { ...row, ...session };
}
