import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import {
  renderExomemInviteEmail,
  renderExomemWaitlistEmail,
  renderExomemWelcomeEmail,
} from "@/lib/email-templates/exomem-access";
import {
  admitSelfServeOrWaitlistAtomic,
  createInviteRecord,
  createMagicAccessToken,
  markInviteDelivered,
  markInviteDeliveryFailed,
  inspectValidInvite,
  redeemInviteAtomic,
  redeemMagicAccessTokenAtomic,
  type CreateInviteRecordInput,
  type CreateMagicAccessTokenInput,
  type RedeemInviteAtomicInput,
  type RedeemMagicAccessTokenInput,
  type RedeemedAccess,
  type SelfServeAdmissionInput,
  type SelfServeAdmissionResult,
} from "./db";
import { exomemErrors } from "./errors";
import { EXOMEM_ALPHA_CAPACITY } from "./oauth-admission";
import {
  exomemPublicBaseUrlFromEnv,
  exomemPublicFragmentUrl,
  parseExomemPublicBaseUrl,
} from "./public-origin";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";
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

// Shorter than an operator invitation's ceiling: a self-serve invite holds a
// place against the pool while it is outstanding, so an abandoned signup must
// return that place quickly rather than in a month.
const SELF_SERVE_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// `created_by_principal_digest` is NOT NULL because operator invites are
// attributable. Nobody authorised a self-serve invite, so it carries a fixed
// sentinel rather than a fabricated operator identity.
const SELF_SERVE_PRINCIPAL_DIGEST = createHash("sha256")
  .update("exomem:self-serve-admission")
  .digest();

const ALPHA_CAPABILITIES = ["capture", "recall", "export"];
const ALPHA_LIMITS = {
  storageBytes: 5 * 1024 * 1024 * 1024,
  uploadBytes: 90 * 1024 * 1024,
  workerCount: 0,
};

type SendEmail = typeof sendTransactionalEmail;

export type AccessDependencies = {
  now: () => Date;
  randomBytes: RandomBytesSource;
  publicBaseUrl: string;
  createInvite: (input: CreateInviteRecordInput) => Promise<{ inviteId: string }>;
  markInviteDelivered: (inviteId: string) => Promise<void>;
  markInviteDeliveryFailed: (inviteId: string, errorCode: string) => Promise<void>;
  inspectInvite: typeof inspectValidInvite;
  redeemInviteAtomic: (input: RedeemInviteAtomicInput) => Promise<RedeemedAccess | null>;
  admitSelfServeOrWaitlist: (input: SelfServeAdmissionInput) => Promise<SelfServeAdmissionResult>;
  createMagicAccessToken: (
    input: CreateMagicAccessTokenInput
  ) => Promise<{ tokenId: string; emailNormalized?: string } | null>;
  encryptDeliverySecret: (value: string) => SecretEnvelope;
  redeemMagicAccessTokenAtomic: (
    input: RedeemMagicAccessTokenInput
  ) => Promise<Omit<RedeemedAccess, "operationId"> | null>;
  sendEmail: SendEmail;
  takeRateLimit: (
    rule: (typeof EXOMEM_RATE_LIMITS)[keyof typeof EXOMEM_RATE_LIMITS],
    value: string
  ) => Promise<boolean>;
  completeMagicLinkRequest: (startedAt: Date) => Promise<void>;
};

function defaults(): AccessDependencies {
  return {
    now: () => new Date(),
    randomBytes: nodeRandomBytes,
    publicBaseUrl: exomemPublicBaseUrlFromEnv(),
    createInvite: createInviteRecord,
    markInviteDelivered,
    markInviteDeliveryFailed,
    inspectInvite: inspectValidInvite,
    redeemInviteAtomic,
    admitSelfServeOrWaitlist: admitSelfServeOrWaitlistAtomic,
    createMagicAccessToken,
    encryptDeliverySecret: (value) => encryptSecret(value),
    redeemMagicAccessTokenAtomic,
    sendEmail: sendTransactionalEmail,
    takeRateLimit: takeExomemRateLimit,
    completeMagicLinkRequest: async (startedAt) => {
      const remainingMs = 300 - (Date.now() - startedAt.getTime());
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, remainingMs));
      }
    },
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
    capabilities: ALPHA_CAPABILITIES,
    resourceLimits: ALPHA_LIMITS,
    marketplaceReviewerPurpose: input.marketplaceReviewerPurpose === true,
    operatorPrincipalDigest: input.operatorPrincipalDigest,
    expiresAt: input.expiresAt,
  });

  const accessUrl = exomemPublicFragmentUrl(publicBaseUrl, "/exomem/invite", token);
  const rendered = renderExomemInviteEmail({
    accessUrl,
    expiresAt: input.expiresAt,
  });
  let delivery: Awaited<ReturnType<SendEmail>>;
  try {
    delivery = await deps.sendEmail({
      to: emailNormalized,
      senderName: "Exomem",
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

/**
 * Self-serve admission: a visitor asks for a place, and capacity — not an
 * operator — answers.
 *
 * The outcome is deliberately told plainly rather than behind the magic-link
 * route's generic "if eligible" response. That route hides whether an account
 * exists; this one answers a question about the *pool*, which is the same answer
 * for every visitor, so there is no account-enumeration oracle to protect. A
 * visitor who is waitlisted must know it, because the alternative is discovering
 * it after paying.
 */
export async function requestSelfServeAccess(
  input: {
    email: string;
    networkKey: string;
  },
  dependencies?: Partial<AccessDependencies>
): Promise<{ outcome: "admitted" | "waitlisted"; position?: number }> {
  const deps = withDefaults(dependencies);
  const emailNormalized = normalizeAccessEmail(input.email);

  const networkAllowed = await deps.takeRateLimit(EXOMEM_RATE_LIMITS.admissionIp, input.networkKey);
  if (!networkAllowed) throw exomemErrors.rateLimited();
  const accountAllowed = await deps.takeRateLimit(
    EXOMEM_RATE_LIMITS.admissionEmail,
    emailNormalized
  );
  if (!accountAllowed) throw exomemErrors.rateLimited();

  const publicBaseUrl = parseExomemPublicBaseUrl(deps.publicBaseUrl);
  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const expiresAt = new Date(deps.now().getTime() + SELF_SERVE_INVITE_TTL_MS);

  const decision = await deps.admitSelfServeOrWaitlist({
    tokenDigest: digest,
    emailNormalized,
    capabilities: ALPHA_CAPABILITIES,
    resourceLimits: ALPHA_LIMITS,
    principalDigest: SELF_SERVE_PRINCIPAL_DIGEST,
    expiresAt,
    storageBytes: EXOMEM_ALPHA_CAPACITY.storageBytes,
    runtimeSlots: EXOMEM_ALPHA_CAPACITY.runtimeSlots,
    provisionSlots: EXOMEM_ALPHA_CAPACITY.provisionReservationSlots,
  });

  if (decision.outcome === "waitlisted") {
    const rendered = renderExomemWaitlistEmail({ position: decision.position });
    // A waitlist confirmation is a courtesy, not the record. The row is already
    // committed, so a mail failure must not turn into a retry that re-queues
    // them or, worse, an error that reads as rejection.
    try {
      await deps.sendEmail({
        to: emailNormalized,
        senderName: "Exomem",
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        textContent: rendered.textContent,
      });
    } catch {
      // Intentionally swallowed; the visitor already has their answer on screen.
    }
    return { outcome: "waitlisted", position: decision.position };
  }

  const accessUrl = exomemPublicFragmentUrl(publicBaseUrl, "/exomem/invite", token);
  const rendered = renderExomemWelcomeEmail({ accessUrl, expiresAt });
  let delivery: Awaited<ReturnType<SendEmail>>;
  try {
    delivery = await deps.sendEmail({
      to: emailNormalized,
      senderName: "Exomem",
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
  } catch {
    delivery = { success: false };
  }
  if (!delivery.success) {
    // The token only exists in that email. An undelivered invite is a soft
    // capacity reservation nobody can consume, so it is revoked rather than left
    // to hold a place against the pool until it expires.
    await deps.markInviteDeliveryFailed(decision.inviteId, "EMAIL_DELIVERY_UNAVAILABLE");
    throw exomemErrors.emailDeliveryUnavailable();
  }
  await deps.markInviteDelivered(decision.inviteId);
  return { outcome: "admitted" };
}

export type RedeemedBrowserAccess = RedeemedAccess & SessionMaterial;

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

export async function redeemInvite(
  token: string,
  dependencies?: Partial<AccessDependencies>
): Promise<RedeemedBrowserAccess> {
  const deps = withDefaults(dependencies);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const session = mintSessionMaterial({
    now: deps.now(),
    randomBytes: deps.randomBytes,
  });
  const row = await deps.redeemInviteAtomic({
    tokenDigest: digest,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
  });
  if (!row) throw exomemErrors.accessTokenInvalid();
  return { ...row, ...session };
}

export async function requestMagicLink(
  input: {
    email: string;
    networkKey: string;
    browserChallengeDigest: Buffer;
  },
  dependencies?: Partial<AccessDependencies>
): Promise<{ accepted: true }> {
  const deps = withDefaults(dependencies);
  const startedAt = deps.now();
  const accept = async (): Promise<{ accepted: true }> => {
    await deps.completeMagicLinkRequest(startedAt);
    return { accepted: true };
  };
  const networkAllowed = await deps.takeRateLimit(EXOMEM_RATE_LIMITS.magicLinkIp, input.networkKey);
  if (!networkAllowed) return accept();

  let emailNormalized: string;
  try {
    emailNormalized = normalizeAccessEmail(input.email);
  } catch {
    return accept();
  }

  const accountAllowed = await deps.takeRateLimit(
    EXOMEM_RATE_LIMITS.magicLinkAccount,
    emailNormalized
  );
  if (!accountAllowed) return accept();

  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) return accept();
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
    browserChallengeDigest: input.browserChallengeDigest,
    expiresAt,
    deliverySecretCiphertext,
  });
  if (!created) return accept();
  return accept();
}

export async function redeemMagicLink(
  input: { token: string; browserChallenge: string },
  dependencies?: Partial<AccessDependencies>
): Promise<Omit<RedeemedBrowserAccess, "operationId">> {
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
  });
  if (!row) throw exomemErrors.accessTokenInvalid();
  return { ...row, ...session };
}
