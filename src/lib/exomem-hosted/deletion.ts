import { randomBytes as nodeRandomBytes } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { EXOMEM_SENDER } from "@/lib/exomem-hosted/mail-sender";
import { renderExomemDeletionEmail } from "@/lib/email-templates/exomem-access";
import { finishCloudAccountDeletion } from "./cloud-deletion-finish";
import { reconcileCloudCellDesiredState } from "./cloud-lifecycle";
import {
  consumeDeletionConfirmationAtomic,
  createDeletionConfirmationToken,
  markAccessTokenDelivered,
  markAccessTokenDeliveryFailed,
} from "./db";
import { exomemErrors } from "./errors";
import {
  exomemPublicBaseUrlFromEnv,
  exomemPublicFragmentUrl,
  parseExomemPublicBaseUrl,
} from "./public-origin";
import { EXOMEM_RATE_LIMITS, takeExomemRateLimit } from "./rate-limit";
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
  reconcileCloud: (tenantId: string) => Promise<unknown>;
  finishCloud: (tenantId: string) => Promise<unknown>;
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
    reconcileCloud: (tenantId) => reconcileCloudCellDesiredState(tenantId),
    finishCloud: (tenantId) => finishCloudAccountDeletion(tenantId),
    sendEmail: sendTransactionalEmail,
  };
}

function withDefaults(dependencies?: Partial<DeletionDependencies>): DeletionDependencies {
  return { ...defaults(), ...dependencies };
}

export async function requestDeletionConfirmation(
  session: { userId: string; tenantId: string },
  dependencies?: Partial<DeletionDependencies>
): Promise<{ delivery: "sent"; expiresAt: Date }> {
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
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + DELETION_CONFIRMATION_TTL_MS);
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
    now,
    timeZone: created.timeZone,
  });
  let delivery: Awaited<ReturnType<typeof sendTransactionalEmail>>;
  try {
    delivery = await deps.sendEmail({
      to: created.emailNormalized,
      ...EXOMEM_SENDER,
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
  return { delivery: "sent", expiresAt };
}

export async function confirmDeletion(
  token: string,
  session: { userId: string; tenantId: string },
  dependencies?: Partial<DeletionDependencies>
): Promise<{ state: "deletion_pending" }> {
  const deps = withDefaults(dependencies);
  const digest = tokenDigest(token);
  if (!digest) throw exomemErrors.accessTokenInvalid();
  const consumed = await deps.consume({
    userId: session.userId,
    tenantId: session.tenantId,
    tokenDigest: digest,
  });
  if (!consumed) throw exomemErrors.accessTokenInvalid();
  // The confirmed deletion reaches the tenant's cell row (and revokes its
  // consent) now, and the Cloud deletion finish then cancels billing and
  // scrubs the tenant. The periodic Cloud sweep is the backstop for both.
  await deps.reconcileCloud(session.tenantId).catch(() => undefined);
  await deps.finishCloud(session.tenantId).catch(() => undefined);
  return { state: "deletion_pending" };
}
