import { randomUUID } from "node:crypto";
import { sendTransactionalEmail } from "@/lib/brevo";
import { renderExomemDeletionCompleteEmail } from "@/lib/email-templates/exomem-access";
import {
  claimDeletionCompletionDelivery,
  markDeletionCompletionDeliverySent,
  releaseDeletionCompletionDelivery,
  type ClaimedDeletionCompletionDelivery,
} from "./db";
import { EXOMEM_EMAIL_SENDER } from "./email-sender";

type SendEmail = typeof sendTransactionalEmail;

export type DeletionCompletionDeliveryDependencies = {
  newLeaseOwner: () => string;
  claim: (input: {
    leaseOwner: string;
    leaseSeconds?: number;
  }) => Promise<ClaimedDeletionCompletionDelivery | null>;
  markSent: (input: { deliveryId: string; leaseOwner: string }) => Promise<boolean>;
  release: (input: {
    deliveryId: string;
    leaseOwner: string;
    errorCode: string;
  }) => Promise<"retry" | "failed" | "lost">;
  sendEmail: SendEmail;
};

function defaults(): DeletionCompletionDeliveryDependencies {
  return {
    newLeaseOwner: randomUUID,
    claim: claimDeletionCompletionDelivery,
    markSent: markDeletionCompletionDeliverySent,
    release: releaseDeletionCompletionDelivery,
    sendEmail: sendTransactionalEmail,
  };
}

export async function drainDeletionCompletionDeliveries(
  options: { maxMessages?: number; timeBudgetMs?: number } = {},
  dependencies?: Partial<DeletionCompletionDeliveryDependencies>
): Promise<{
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
  const result = { claimed: 0, sent: 0, retryScheduled: 0, failed: 0, lost: 0 };

  while (result.claimed < maxMessages && Date.now() - started < timeBudgetMs) {
    const record = await deps.claim({ leaseOwner, leaseSeconds: 60 });
    if (!record) break;
    result.claimed += 1;
    const rendered = renderExomemDeletionCompleteEmail();
    let delivered = false;
    try {
      delivered = (
        await deps.sendEmail({
          to: record.emailNormalized,
          ...EXOMEM_EMAIL_SENDER,
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
    });
    if (state === "retry") result.retryScheduled += 1;
    else if (state === "failed") result.failed += 1;
    else result.lost += 1;
  }

  return result;
}
