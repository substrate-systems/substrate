import { NextRequest, NextResponse } from "next/server";
import { withApiVersion } from "@/lib/hosted-backup/api-version";
import { verifyCronAuth } from "@/lib/hosted-backup/cron-auth";
import { captureCronOutcome } from "@/lib/analytics-server";
import {
  findFounderAlertableClaims,
  findResendableClaims,
  markCronResent,
  markFounderAlerted,
} from "@/lib/hosted-backup/claim-tokens";
import {
  findPendingPaddleCancellations,
  findPendingSupporterEmails,
  getSupporterEmailAttentionCount,
  findUserById,
  getPaddleCancellationAttentionCount,
  markPaddleCancellationAttempt,
  markSupporterEmailDelivered,
  markSupporterEmailFailed,
} from "@/lib/hosted-backup/db";
import { cancelPaddleSubscription } from "@/lib/hosted-backup/subscriptions";
import { sendTransactionalEmail } from "@/lib/brevo";
import { renderFounderDigest, renderResendClaimEmail } from "@/lib/email-templates/claim";
import { renderSupporterThankYou } from "@/lib/email-templates/supporter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FOUNDER_FALLBACK_EMAIL = "founder@substratesystems.io";

function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return withApiVersion(NextResponse.json(body, { status }));
}

export async function GET(req: NextRequest) {
  if (!verifyCronAuth(req).ok) {
    return ok({ success: false, error: { code: "UNAUTHENTICATED" } }, 401);
  }

  // Pass 1: resend the claim email for unclaimed tokens that haven't been
  // touched in 23h+ and are under the resend cap (2).
  const resendable = await findResendableClaims();
  let resent = 0;
  for (const claim of resendable) {
    // We need the *plaintext* token to render the URL — but the cron only
    // holds hashes. The token can no longer be recovered, so the resend email
    // must include a generic "your claim is still pending" message and
    // direct the user to email founder@. This is a real limitation of
    // hash-only storage.
    //
    // For v1 we use the existing template with a placeholder token; the URL
    // will 404 but the plaintext code shown in the email body will be
    // useless (it's a slice of the original token). The recipient is still
    // notified the claim exists. A follow-up could store an encrypted token
    // separately to enable real resends.
    //
    // To avoid sending a broken URL we surface a contact-us message instead.
    // Build a minimal "your claim is still pending" body inline.
    const body = renderClaimStillPendingBody({ email: claim.email });
    const send = await sendTransactionalEmail({
      to: claim.email,
      subject: body.subject,
      htmlContent: body.htmlContent,
      textContent: body.textContent,
    });
    if (!send.success) {
      console.warn("[hosted-backup cron/claim-followups] resend send failed", {
        email: claim.email,
        error: send.error,
      });
      // Don't bump on failure — we'll retry next run.
      continue;
    }
    await markCronResent(claim.tokenHash);
    resent += 1;
  }

  // Pass 2: rows ≥14 days unclaimed without a founder alert.
  const alertable = await findFounderAlertableClaims();
  let founderAlerted = 0;
  if (alertable.length > 0) {
    // Enrich emails. The claim row already carries email + createdAt + cust id.
    const pendingClaims = alertable.map((a) => ({
      email: a.email,
      createdAt: a.createdAt,
      paddleCustomerId: a.paddleCustomerId,
    }));
    const rendered = renderFounderDigest({ pendingClaims });
    const to = process.env.CLAIM_FOUNDER_ALERT_EMAIL ?? FOUNDER_FALLBACK_EMAIL;
    const send = await sendTransactionalEmail({
      to,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
    if (send.success) {
      await markFounderAlerted(alertable.map((a) => a.tokenHash));
      founderAlerted = alertable.length;
    } else {
      console.error("[hosted-backup cron/claim-followups] founder digest send failed", {
        error: send.error,
      });
    }
  }

  let supporterEmailsSent = 0;
  let supporterEmailsAttentionRequired = 0;
  for (const row of await findPendingSupporterEmails(20)) {
    if (row.kind === "supporter_thank_you" && !row.customer_email) {
      await markSupporterEmailDelivered(row.id);
      continue;
    }
    const thankYou =
      row.kind === "supporter_thank_you" ? renderSupporterThankYou({ tier: row.tier }) : null;
    const delivery = await sendTransactionalEmail({
      to: row.kind === "founder_notification" ? FOUNDER_FALLBACK_EMAIL : row.customer_email!,
      subject:
        row.kind === "founder_notification"
          ? `New Endstate ${row.tier}: ${row.paddle_transaction_id}`
          : thankYou!.subject,
      htmlContent:
        row.kind === "founder_notification"
          ? `<p>New Endstate ${row.tier} contribution.</p><p>Transaction: ${row.paddle_transaction_id}</p>`
          : thankYou!.htmlContent,
      textContent:
        row.kind === "founder_notification"
          ? `New Endstate ${row.tier} contribution. Transaction: ${row.paddle_transaction_id}`
          : thankYou!.textContent,
    });
    if (delivery.success) {
      await markSupporterEmailDelivered(row.id);
      supporterEmailsSent += 1;
    } else {
      const attempt = await markSupporterEmailFailed(
        row.id,
        delivery.error ?? "unknown delivery error"
      );
      if (attempt.attentionRequired) {
        console.error(
          "[hosted-backup cron/claim-followups] supporter email requires operator attention",
          {
            outboxId: row.id,
          }
        );
      }
    }
  }
  supporterEmailsAttentionRequired = await getSupporterEmailAttentionCount();

  let paddleCancellationsCompleted = 0;
  let paddleCancellationsAttentionRequired = 0;
  for (const tombstone of await findPendingPaddleCancellations(20)) {
    try {
      const cancelled = await cancelPaddleSubscription(tombstone.paddle_subscription_id);
      const attempt = await markPaddleCancellationAttempt(
        tombstone.id,
        cancelled,
        cancelled ? undefined : "Paddle cancellation returned false"
      );
      if (attempt.attentionRequired && !cancelled) {
        console.error(
          "[hosted-backup cron/claim-followups] Paddle cancellation requires operator attention",
          { tombstoneId: tombstone.id }
        );
      }
      if (cancelled) paddleCancellationsCompleted += 1;
    } catch (err) {
      const attempt = await markPaddleCancellationAttempt(tombstone.id, false, String(err));
      if (attempt.attentionRequired) {
        console.error(
          "[hosted-backup cron/claim-followups] Paddle cancellation requires operator attention",
          { tombstoneId: tombstone.id }
        );
      }
    }
  }
  paddleCancellationsAttentionRequired = await getPaddleCancellationAttentionCount();

  // Suppress unused-import warning for findUserById (kept available for the
  // follow-up that enriches digests with user-created-at).
  void findUserById;
  void renderResendClaimEmail;

  await captureCronOutcome({
    job: "claim-followups",
    outcome: "completed",
    properties: {
      resent,
      founderAlerted,
      supporterEmailsSent,
      supporterEmailsAttentionRequired,
      paddleCancellationsCompleted,
      paddleCancellationsAttentionRequired,
    },
  });

  return ok(
    {
      ok: true,
      resent,
      founderAlerted,
      supporterEmailsSent,
      supporterEmailsAttentionRequired,
      paddleCancellationsCompleted,
      paddleCancellationsAttentionRequired,
    },
    200
  );
}

// Lightweight "your claim is still pending" body for the resend pass. We
// don't have the plaintext token in cron (only the hash), so the body
// can't include the claim URL or paste-code. It's a nudge — "we still see
// your purchase; reply to recover" — not a re-issuance.
function renderClaimStillPendingBody({ email }: { email: string }) {
  void email;
  const subject = "Your Endstate Cloud subscription is still waiting";
  const supportEmail = "founder@substratesystems.io";
  const text = `Your Endstate Cloud subscription is still unclaimed.

If you've lost the original claim link, reply to this email and we'll send a fresh one — we don't store claim tokens in a form we can re-send automatically.

— Hugo, Substrate Systems`;
  const html = `<!doctype html>
<html>
  <body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; color: #111; max-width: 560px; margin: 0 auto; padding: 32px; background: #ffffff;">
    <p style="font-size: 16px; line-height: 1.6; margin: 0 0 16px;">Your Endstate Cloud subscription is still unclaimed.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #333; margin: 0 0 16px;">If you&rsquo;ve lost the original claim link, reply to this email and we&rsquo;ll send a fresh one — we don&rsquo;t store claim tokens in a form we can re-send automatically.</p>
    <p style="font-size: 14px; line-height: 1.6; color: #111; margin: 24px 0 0;">&mdash; Hugo, Substrate Systems</p>
    <p style="font-size: 12px; color: #999; margin: 16px 0 0;">Reply directly to this email or write to ${supportEmail}.</p>
  </body>
</html>`;
  return { subject, htmlContent: html, textContent: text };
}
