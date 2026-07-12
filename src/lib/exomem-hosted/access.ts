import { randomBytes as nodeRandomBytes } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import {
  renderExomemInviteEmail,
  renderExomemMagicLinkEmail,
} from "@/lib/email-templates/exomem-access";
import {
  createInviteRecord,
  createMagicAccessToken,
  markAccessTokenDelivered,
  markAccessTokenDeliveryFailed,
  markInviteDelivered,
  markInviteDeliveryFailed,
  redeemInviteAtomic,
  redeemMagicAccessTokenAtomic,
  type CreateInviteRecordInput,
  type CreateMagicAccessTokenInput,
  type RedeemInviteAtomicInput,
  type RedeemMagicAccessTokenInput,
  type RedeemedAccess,
} from "./db";
import { exomemErrors } from "./errors";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";
import { mintSessionMaterial, type SessionMaterial } from "./sessions";
import { generateExternalToken, tokenDigest, type RandomBytesSource } from "./security";

const EMAIL = /^[^\s<>"'`&]+@[^\s<>"'`&]+\.[^\s<>"'`&]+$/;
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000;
const MAX_INVITE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const ALPHA_CAPABILITIES = ["capture", "recall", "export"];
const ALPHA_LIMITS = {
  storageBytes: 5 * 1024 * 1024 * 1024,
  uploadBytes: 100 * 1024 * 1024,
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
  redeemInviteAtomic: (input: RedeemInviteAtomicInput) => Promise<RedeemedAccess | null>;
  createMagicAccessToken: (
    input: CreateMagicAccessTokenInput
  ) => Promise<{ tokenId: string; emailNormalized?: string } | null>;
  markAccessTokenDelivered: (tokenId: string) => Promise<void>;
  markAccessTokenDeliveryFailed: (tokenId: string, errorCode: string) => Promise<void>;
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
    publicBaseUrl: process.env.EXOMEM_PUBLIC_BASE_URL ?? "https://substratesystems.io",
    createInvite: createInviteRecord,
    markInviteDelivered,
    markInviteDeliveryFailed,
    redeemInviteAtomic,
    createMagicAccessToken,
    markAccessTokenDelivered,
    markAccessTokenDeliveryFailed,
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

function fragmentUrl(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.hash = token;
  return url.toString();
}

export async function issueOperatorInvite(
  input: {
    email: string;
    source: "complimentary" | "paid";
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

  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const { inviteId } = await deps.createInvite({
    tokenDigest: digest,
    emailNormalized,
    entitlementSource: input.source === "complimentary" ? "complimentary" : "paddle",
    capabilities: ALPHA_CAPABILITIES,
    resourceLimits: ALPHA_LIMITS,
    operatorPrincipalDigest: input.operatorPrincipalDigest,
    expiresAt: input.expiresAt,
  });

  const accessUrl = fragmentUrl(deps.publicBaseUrl, "/exomem/invite", token);
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

export type RedeemedBrowserAccess = RedeemedAccess & SessionMaterial;

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
  email: string,
  networkKey: string | null,
  dependencies?: Partial<AccessDependencies>
): Promise<{ accepted: true }> {
  const deps = withDefaults(dependencies);
  const startedAt = deps.now();
  const accept = async (): Promise<{ accepted: true }> => {
    await deps.completeMagicLinkRequest(startedAt);
    return { accepted: true };
  };
  let emailNormalized: string;
  try {
    emailNormalized = normalizeAccessEmail(email);
  } catch {
    return accept();
  }

  const accountAllowed = await deps.takeRateLimit(
    EXOMEM_RATE_LIMITS.magicLinkAccount,
    emailNormalized
  );
  const networkAllowed = networkKey
    ? await deps.takeRateLimit(EXOMEM_RATE_LIMITS.magicLinkIp, networkKey)
    : true;
  if (!accountAllowed || !networkAllowed) return accept();

  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) return accept();
  const expiresAt = new Date(deps.now().getTime() + MAGIC_LINK_TTL_MS);
  const created = await deps.createMagicAccessToken({
    emailNormalized,
    tokenDigest: digest,
    expiresAt,
  });
  if (!created) return accept();

  const accessUrl = fragmentUrl(deps.publicBaseUrl, "/exomem/invite", token);
  const rendered = renderExomemMagicLinkEmail({ accessUrl, expiresAt });
  let delivery: Awaited<ReturnType<SendEmail>>;
  try {
    delivery = await deps.sendEmail({
      to: created.emailNormalized ?? emailNormalized,
      senderName: "Exomem",
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
  } catch {
    delivery = { success: false };
  }
  if (!delivery.success) {
    await deps.markAccessTokenDeliveryFailed(created.tokenId, "EMAIL_DELIVERY_UNAVAILABLE");
    return accept();
  }
  await deps.markAccessTokenDelivered(created.tokenId);
  return accept();
}

export async function redeemMagicLink(
  token: string,
  dependencies?: Partial<AccessDependencies>
): Promise<Omit<RedeemedBrowserAccess, "operationId">> {
  const deps = withDefaults(dependencies);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const session = mintSessionMaterial({
    now: deps.now(),
    randomBytes: deps.randomBytes,
  });
  const row = await deps.redeemMagicAccessTokenAtomic({
    tokenDigest: digest,
    sessionDigest: session.sessionDigest,
    csrfDigest: session.csrfDigest,
    sessionExpiresAt: session.expiresAt,
  });
  if (!row) throw exomemErrors.accessTokenInvalid();
  return { ...row, ...session };
}
