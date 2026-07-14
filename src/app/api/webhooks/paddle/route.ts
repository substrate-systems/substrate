import { NextRequest, NextResponse } from "next/server";
import {
  PaddleSignatureError,
  fetchPaddleCustomerEmail,
  verifyPaddleSignature,
} from "@/lib/license/paddle";
import { withApiVersion } from "@/lib/hosted-backup/api-version";
import {
  claimPaddleEventProcessing,
  claimSubscriptionOnboardingDelivery,
  ensurePreAccount,
  getSubscriptionByUserId,
  markPaddleEventProcessed,
  markSubscriptionOnboardingSent,
  releasePaddleEventForRetry,
  releaseSubscriptionOnboardingForRetry,
  userHasAuthCredentials,
} from "@/lib/hosted-backup/db";
import {
  applyPaddleEvent,
  isHandledEvent,
  type EmailResolver,
  type PaddleSubscriptionEvent,
} from "@/lib/hosted-backup/subscriptions";
import {
  markInitialClaimEmailFailed,
  markInitialClaimEmailSent,
  prepareInitialClaimToken,
} from "@/lib/hosted-backup/claim-tokens";
import { sendTransactionalEmail } from "@/lib/brevo";
import { renderClaimEmail, renderFyiEmail } from "@/lib/email-templates/claim";
import { dispatchVerifiedExomemPaddleEvent } from "@/lib/exomem-hosted/paddle-webhook";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return withApiVersion(NextResponse.json(body, { status }));
}

class WebhookProcessingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "WebhookProcessingError";
  }
}

function processingErrorCode(err: unknown, fallback: string): string {
  return err instanceof WebhookProcessingError ? err.code : fallback;
}

// Closure for the email-fallback path. Customer lookup is required for an
// anonymous first-subscription event, so transient failures must escape and
// make Paddle retry rather than being converted into a successful no-op.
function makeEmailResolver(): EmailResolver {
  return async (customerId) => {
    let email: string | null;
    try {
      email = await fetchPaddleCustomerEmail(customerId);
    } catch {
      console.warn("[hosted-backup paddle webhook] fetchPaddleCustomerEmail failed", {
        customerId,
        code: "PADDLE_CUSTOMER_LOOKUP_FAILED",
      });
      throw new WebhookProcessingError("PADDLE_CUSTOMER_LOOKUP_FAILED");
    }
    if (!email) {
      console.warn("[hosted-backup paddle webhook] Paddle customer has no email", {
        customerId,
        code: "PADDLE_CUSTOMER_EMAIL_MISSING",
      });
      throw new WebhookProcessingError("PADDLE_CUSTOMER_EMAIL_MISSING");
    }
    return ensurePreAccount(email);
  };
}

async function retryableFailure(
  event: PaddleSubscriptionEvent,
  attempt: number,
  code: string
): Promise<NextResponse> {
  console.error("[hosted-backup paddle webhook] retryable failure", {
    event_id: event.event_id,
    event_type: event.event_type,
    code,
  });
  try {
    await releasePaddleEventForRetry(event.event_id, attempt, code);
  } catch {
    console.error("[hosted-backup paddle webhook] failed to release event lease", {
      event_id: event.event_id,
      code: "PADDLE_EVENT_RELEASE_FAILED",
    });
  }
  return ok({ success: false, error: { code } }, 503);
}

function hostedBackupPriceClassification(event: PaddleSubscriptionEvent): {
  configured: boolean;
  matches: boolean;
} {
  const configuredPriceIds = new Set(
    [
      process.env.PADDLE_PRICE_ID_HOSTED_BACKUP,
      process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_MONTHLY,
      process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_HOSTED_BACKUP_YEARLY,
    ].filter((value): value is string => Boolean(value))
  );
  const eventPriceIds = (event.data?.items ?? [])
    .map((item) => item.price?.id)
    .filter((value): value is string => Boolean(value));
  return {
    configured: configuredPriceIds.size > 0,
    matches: eventPriceIds.some((priceId) => configuredPriceIds.has(priceId)),
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret =
    process.env.PADDLE_HOSTED_BACKUP_WEBHOOK_SECRET ?? process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[hosted-backup paddle webhook] webhook secret is not set", {
      code: "PADDLE_HOSTED_BACKUP_WEBHOOK_SECRET_MISSING",
    });
    return ok({ success: false, error: { code: "SERVER_MISCONFIGURED" } }, 500);
  }

  const rawBody = await req.text();

  try {
    verifyPaddleSignature({
      header: req.headers.get("paddle-signature"),
      rawBody,
      secret,
    });
  } catch (err) {
    if (err instanceof PaddleSignatureError) {
      return ok(
        {
          success: false,
          error: { code: "PADDLE_SIGNATURE_INVALID", message: err.message },
        },
        401
      );
    }
    throw err;
  }

  let event: PaddleSubscriptionEvent;
  try {
    event = JSON.parse(rawBody) as PaddleSubscriptionEvent;
  } catch {
    return ok(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "invalid JSON" },
      },
      400
    );
  }

  if (typeof event.event_id !== "string" || event.event_id.length === 0) {
    return ok(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "event_id is required" },
      },
      400
    );
  }
  if (typeof event.event_type !== "string") {
    return ok(
      {
        success: false,
        error: { code: "BAD_REQUEST", message: "event_type is required" },
      },
      400
    );
  }

  let exomemResult;
  try {
    exomemResult = await dispatchVerifiedExomemPaddleEvent(event);
  } catch {
    console.error("[exomem paddle webhook] dispatch failed", {
      code: "EXOMEM_PADDLE_TRANSIENT_FAILURE",
    });
    return ok(
      {
        success: false,
        error: { code: "EXOMEM_PADDLE_TRANSIENT_FAILURE" },
      },
      503
    );
  }
  if (exomemResult.kind === "rejected") {
    return ok({ success: false, error: { code: exomemResult.code } }, exomemResult.status);
  }
  if (exomemResult.kind === "handled") {
    return ok(
      {
        ok: true,
        product: "exomem-hosted",
        outcome: exomemResult.outcome,
      },
      200
    );
  }

  if (isHandledEvent(event.event_type)) {
    const classification = hostedBackupPriceClassification(event);
    if (!classification.configured) {
      console.error("[hosted-backup paddle webhook] price configuration missing", {
        event_id: event.event_id,
        code: "HOSTED_BACKUP_PRICE_CONFIG_MISSING",
      });
      return ok({ success: false, error: { code: "SERVER_MISCONFIGURED" } }, 500);
    }
    if (!classification.matches) {
      return ok({ ok: true, ignored: true, reason: "not_hosted_backup_price" }, 200);
    }
  }

  // Idempotency is a processing lease. Only a completed event dedupes to 200;
  // failed or abandoned attempts can be reacquired safely.
  let eventClaim;
  try {
    eventClaim = await claimPaddleEventProcessing({
      eventId: event.event_id,
      eventType: event.event_type,
    });
  } catch {
    console.error("[hosted-backup paddle webhook] event claim failed", {
      event_id: event.event_id,
      code: "PADDLE_EVENT_CLAIM_FAILED",
    });
    return ok(
      {
        success: false,
        error: { code: "PADDLE_EVENT_CLAIM_FAILED" },
      },
      503
    );
  }

  if (eventClaim.kind === "processed") {
    return ok({ ok: true, deduped: true }, 200);
  }
  if (eventClaim.kind === "in_progress") {
    return ok({ success: false, error: { code: "PADDLE_EVENT_IN_PROGRESS" } }, 503);
  }
  const eventAttempt = eventClaim.attempt;

  if (!isHandledEvent(event.event_type)) {
    console.warn("[hosted-backup paddle webhook] ignoring unhandled event_type:", event.event_type);
    await markPaddleEventProcessed(event.event_id, eventAttempt);
    return ok({ ok: true, ignored: true, event_type: event.event_type }, 200);
  }

  let result;
  try {
    result = await applyPaddleEvent(event, {
      resolveByEmail: makeEmailResolver(),
    });
  } catch (err) {
    return retryableFailure(
      event,
      eventAttempt,
      processingErrorCode(err, "PADDLE_EVENT_APPLY_FAILED")
    );
  }

  if (result.kind === "unknown_user") {
    return retryableFailure(event, eventAttempt, "PADDLE_USER_UNRESOLVED");
  }
  if (result.kind === "ignored") {
    await markPaddleEventProcessed(event.event_id, eventAttempt);
    return ok({ ok: true, ignored: true, reason: result.reason }, 200);
  }

  // If we resolved via the email-fallback path, fire the right follow-up
  // email. The claim primitive is keyed by event_id, so Brevo failures can
  // safely make Paddle retry without duplicating token rows.
  if (result.preAccountFlow) {
    try {
      await dispatchPostResolveEmail(result.userId, event);
    } catch (err) {
      return retryableFailure(
        event,
        eventAttempt,
        processingErrorCode(err, "ONBOARDING_EMAIL_DISPATCH_FAILED")
      );
    }
  }

  try {
    await markPaddleEventProcessed(event.event_id, eventAttempt);
  } catch {
    return retryableFailure(event, eventAttempt, "PADDLE_EVENT_COMPLETE_FAILED");
  }

  return ok({ ok: true, userId: result.userId, status: result.status }, 200);
}

// Looks at the resolved user. If they have no auth_credentials, they're a
// pre-account — mint a claim token + send the claim email. Otherwise they're
// a real existing user who happened to buy via the marketing CTA — send the
// FYI email.
async function dispatchPostResolveEmail(
  userId: string,
  event: PaddleSubscriptionEvent
): Promise<void> {
  const paddleSubscriptionId = event.data?.id;
  if (!paddleSubscriptionId) {
    throw new WebhookProcessingError("ONBOARDING_SUBSCRIPTION_ID_MISSING");
  }
  const hasCreds = await userHasAuthCredentials(userId);
  // We need the email + (for FYI) the subscription detail. Both live on
  // the rows we just touched.
  const sub = await getSubscriptionByUserId(userId);
  if (!sub) {
    // Should not happen — applyPaddleEvent just upserted the row. Log and
    // bail.
    throw new WebhookProcessingError("ONBOARDING_SUBSCRIPTION_MISSING");
  }
  // userHasAuthCredentials told us whether the user is a pre-account; we
  // still need their email. Fetch the users row directly (avoids adding
  // another helper).
  const userRow = await fetchUserEmail(userId);
  if (!userRow) {
    throw new WebhookProcessingError("ONBOARDING_USER_MISSING");
  }
  const emailKind = hasCreds ? "fyi" : "claim";
  const delivery = await claimSubscriptionOnboardingDelivery({
    paddleSubscriptionId,
    eventId: event.event_id,
    emailKind,
  });
  if (delivery.kind === "already_sent") return;
  if (delivery.kind === "in_progress") {
    throw new WebhookProcessingError("ONBOARDING_DELIVERY_IN_PROGRESS");
  }

  try {
    if (!hasCreds) {
      const prepared = await prepareInitialClaimToken({
        userId,
        email: userRow.email,
        sourceEventId: event.event_id,
      });
      if (prepared.kind === "already_sent") {
        await markSubscriptionOnboardingSent({
          paddleSubscriptionId,
          eventId: event.event_id,
        });
        return;
      }
      const rendered = renderClaimEmail({ email: userRow.email, token: prepared.token });
      const sendResult = await sendTransactionalEmail({
        to: userRow.email,
        subject: rendered.subject,
        htmlContent: rendered.htmlContent,
        textContent: rendered.textContent,
      });
      if (!sendResult.success) {
        await markInitialClaimEmailFailed(prepared.tokenHash, "BREVO_CLAIM_EMAIL_FAILED");
        throw new WebhookProcessingError("BREVO_CLAIM_EMAIL_FAILED");
      }
      await markInitialClaimEmailSent(prepared.tokenHash, sendResult.messageId);
      await markSubscriptionOnboardingSent({
        paddleSubscriptionId,
        eventId: event.event_id,
        messageId: sendResult.messageId,
      });
      return;
    }
    const rendered = renderFyiEmail({
      email: userRow.email,
      plan: sub.plan,
      currentPeriodEnd: sub.current_period_end,
    });
    const sendResult = await sendTransactionalEmail({
      to: userRow.email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
    if (!sendResult.success) {
      throw new WebhookProcessingError("BREVO_FYI_EMAIL_FAILED");
    }
    await markSubscriptionOnboardingSent({
      paddleSubscriptionId,
      eventId: event.event_id,
      messageId: sendResult.messageId,
    });
  } catch (err) {
    const code = processingErrorCode(err, "ONBOARDING_EMAIL_DISPATCH_FAILED");
    try {
      await releaseSubscriptionOnboardingForRetry({
        paddleSubscriptionId,
        eventId: event.event_id,
        errorCode: code,
      });
    } catch {
      console.error("[hosted-backup paddle webhook] failed to release onboarding lease", {
        event_id: event.event_id,
        code: "ONBOARDING_DELIVERY_RELEASE_FAILED",
      });
    }
    throw err instanceof WebhookProcessingError ? err : new WebhookProcessingError(code);
  }
}

async function fetchUserEmail(userId: string): Promise<{ email: string } | null> {
  // Small ad-hoc query — pulling in findUserById from db.ts would also work,
  // but it returns a richer shape than we need. Keep it local.
  const { findUserById } = await import("@/lib/hosted-backup/db");
  const row = await findUserById(userId);
  return row ? { email: row.email } : null;
}
