import { randomBytes as nodeRandomBytes } from "node:crypto";
import { OWNER_SIGN_IN_TTL_MS } from "@/lib/exomem/access-limits";
import {
  createMagicAccessToken,
  redeemMagicAccessTokenAtomic,
  type CreateMagicAccessTokenInput,
  type RedeemMagicAccessTokenInput,
  type RedeemedAccess,
} from "./db";
import { exomemErrors } from "./errors";
import { buildOperationalEvent, emitOperationalEvent } from "./observability";
import { EXOMEM_RATE_LIMITS, normalizedEmailRateLimitKey, takeExomemRateLimit } from "./rate-limit";
import {
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

/**
 * Every start request that passed the bot check takes at least this long,
 * whatever its outcome, so its timing does not tell whether the address owns
 * an Exomem, was admitted or was queued.
 */
const START_RESPONSE_FLOOR_MS = 600;

export type AccessDependencies = {
  now: () => Date;
  randomBytes: RandomBytesSource;
  admissionMode: () => SelfServeAdmissionMode;
  startSelfServe: (input: {
    emailNormalized: string;
    timeZone: string | null;
    mode: "waitlist" | "open";
  }) => Promise<StartOutcome>;
  createMagicAccessToken: (
    input: CreateMagicAccessTokenInput
  ) => Promise<{ tokenId: string; deliveryId: string; emailNormalized?: string } | null>;
  encryptDeliverySecret: (value: string) => SecretEnvelope;
  redeemMagicAccessTokenAtomic: (
    input: RedeemMagicAccessTokenInput
  ) => Promise<RedeemedAccess | null>;
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
    // A timer can fire up to about 1 ms early against performance.now(), so wait
    // again until the floor has really passed.
    let waitMs = remainingMs;
    while (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(waitMs)));
      waitMs = START_RESPONSE_FLOOR_MS - (performance.now() - startedAtMs);
    }
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
    admissionMode: () => selfServeAdmissionMode(),
    startSelfServe: (input) => startSelfServeAtomic(input),
    createMagicAccessToken,
    encryptDeliverySecret: (value) => encryptSecret(value),
    redeemMagicAccessTokenAtomic,
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

/**
 * Queues a sign-in link (email 01) for the owner of an Exomem. Returns
 * the private delivery ID, or `null` when the address owns none.
 */
async function queueOwnerSignInLink(
  deps: AccessDependencies,
  emailNormalized: string,
  browserChallengeDigest: Buffer,
  timeZone: string | null
): Promise<string | null> {
  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const expiresAt = new Date(deps.now().getTime() + OWNER_SIGN_IN_TTL_MS);
  const deliverySecretCiphertext = deps.encryptDeliverySecret(
    JSON.stringify({
      version: 1,
      purpose: "magic_link",
      emailNormalized,
      token,
      expiresAt: expiresAt.toISOString(),
      // Delivery-only fallback; this never changes the account time zone.
      timeZone,
    })
  );
  const created = await deps.createMagicAccessToken({
    emailNormalized,
    tokenDigest: digest,
    browserChallengeDigest,
    expiresAt,
    deliverySecretCiphertext,
  });
  return created?.deliveryId ?? null;
}

/**
 * "Start with your email", after the bot check has passed: one request for
 * new and returning people. The caller always answers the same way, and the
 * email carries the outcome:
 *
 * - an owner of an Exomem gets a sign-in link (email 01);
 * - anybody else follows `EXOMEM_SELF_SERVE_ADMISSION`: a start link or a
 *   waitlist place (see
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
    browserKey?: string;
  },
  dependencies?: Partial<AccessDependencies>
): Promise<{ accepted: true; deliveryId?: string }> {
  const deps = withDefaults(dependencies);
  const startedAtMs = performance.now();
  try {
    const networkAllowed = await deps.takeRateLimit(EXOMEM_RATE_LIMITS.startIp, input.networkKey);
    if (!networkAllowed) return { accepted: true };
    if (
      input.browserKey &&
      !(await deps.takeRateLimit(EXOMEM_RATE_LIMITS.startBrowser, input.browserKey))
    )
      return { accepted: true };
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
      const deliveryId = await queueOwnerSignInLink(
        deps,
        emailNormalized,
        input.browserChallengeDigest,
        input.timeZone
      );
      if (deliveryId) {
        return { accepted: true, deliveryId };
      }
      const mode = deps.admissionMode();
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
