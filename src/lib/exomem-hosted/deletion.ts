import { randomBytes as nodeRandomBytes } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { renderExomemDeletionEmail } from "@/lib/email-templates/exomem-access";
import {
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  markAccessTokenDelivered,
  markAccessTokenDeliveryFailed,
} from "./db";
import { exomemErrors } from "./errors";
import { EXOMEM_EMAIL_SENDER } from "./email-sender";
import {
  exomemPublicBaseUrlFromEnv,
  exomemPublicFragmentUrl,
  parseExomemPublicBaseUrl,
} from "./public-origin";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";
import { immediateBestEffortReconcile } from "./reconcile-runtime";
import { generateExternalToken, tokenDigest, type RandomBytesSource } from "./security";

const DELETION_CONFIRMATION_TTL_MS = 15 * 60 * 1000;

export type DeletionDependencies = {
  now: () => Date;
  randomBytes: RandomBytesSource;
  publicBaseUrl: string;
  takeRateLimit: typeof takeExomemRateLimit;
  createToken: typeof createDeletionConfirmationToken;
  markDelivered: typeof markAccessTokenDelivered;
  markFailed: typeof markAccessTokenDeliveryFailed;
  consume: typeof consumeDeletionConfirmationAtomic;
  reconcile: typeof immediateBestEffortReconcile;
  sendEmail: typeof sendTransactionalEmail;
};

function defaults(): DeletionDependencies {
  return {
    now: () => new Date(),
    randomBytes: nodeRandomBytes,
    publicBaseUrl: exomemPublicBaseUrlFromEnv(),
    takeRateLimit: takeExomemRateLimit,
    createToken: createDeletionConfirmationToken,
    markDelivered: markAccessTokenDelivered,
    markFailed: markAccessTokenDeliveryFailed,
    consume: consumeDeletionConfirmationAtomic,
    reconcile: immediateBestEffortReconcile,
    sendEmail: sendTransactionalEmail,
  };
}

function withDefaults(dependencies?: Partial<DeletionDependencies>): DeletionDependencies {
  return { ...defaults(), ...dependencies };
}

export async function requestDeletionConfirmation(
  session: { userId: string; tenantId: string },
  dependencies?: Partial<DeletionDependencies>
): Promise<{ delivery: "sent" }> {
  const deps = withDefaults(dependencies);
  const publicBaseUrl = parseExomemPublicBaseUrl(deps.publicBaseUrl);
  const allowed = await deps.takeRateLimit(
    EXOMEM_RATE_LIMITS.deletionConfirmation,
    session.tenantId
  );
  if (!allowed) throw exomemErrors.rateLimited();

  const token = generateExternalToken(deps.randomBytes);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.invalidRequest();
  const expiresAt = new Date(deps.now().getTime() + DELETION_CONFIRMATION_TTL_MS);
  const created = await deps.createToken({
    userId: session.userId,
    tenantId: session.tenantId,
    tokenDigest: digest,
    expiresAt,
  });
  if (!created) throw exomemErrors.sessionInvalid();

  const rendered = renderExomemDeletionEmail({
    accessUrl: exomemPublicFragmentUrl(publicBaseUrl, "/exomem/delete", token),
    expiresAt,
  });
  let delivery: Awaited<ReturnType<typeof sendTransactionalEmail>>;
  try {
    delivery = await deps.sendEmail({
      to: created.emailNormalized,
      ...EXOMEM_EMAIL_SENDER,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
  } catch {
    delivery = { success: false };
  }
  if (!delivery.success) {
    await deps.markFailed(created.tokenId, "EMAIL_DELIVERY_UNAVAILABLE");
    throw exomemErrors.emailDeliveryUnavailable();
  }
  await deps.markDelivered(created.tokenId);
  return { delivery: "sent" };
}

export async function confirmDeletion(
  token: string,
  session: { userId: string; tenantId: string },
  dependencies?: Partial<DeletionDependencies>
): Promise<{ operationId: string; requestId: string; state: "deletion_pending" }> {
  const deps = withDefaults(dependencies);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const result = await deps.consume({
    userId: session.userId,
    tenantId: session.tenantId,
    tokenDigest: digest,
  });
  if (!result) throw exomemErrors.accessTokenInvalid();
  await deps.reconcile(session.tenantId).catch(() => undefined);
  return { ...result, state: "deletion_pending" };
}
