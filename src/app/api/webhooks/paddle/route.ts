import { NextRequest, NextResponse } from 'next/server';
import {
  PaddleSignatureError,
  fetchPaddleCustomerEmail,
  verifyPaddleSignature,
} from '@/lib/license/paddle';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import {
  ensurePreAccount,
  getSubscriptionByUserId,
  markPaddleEventProcessed,
  recordPaddleEventIfFresh,
  userHasAuthCredentials,
} from '@/lib/hosted-backup/db';
import {
  applyPaddleEvent,
  isHandledEvent,
  type EmailResolver,
  type PaddleSubscriptionEvent,
} from '@/lib/hosted-backup/subscriptions';
import { mintClaimToken } from '@/lib/hosted-backup/claim-tokens';
import { sendTransactionalEmail } from '@/lib/brevo';
import {
  renderClaimEmail,
  renderFyiEmail,
} from '@/lib/email-templates/claim';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return withApiVersion(NextResponse.json(body, { status }));
}

// Closure for the email-fallback path. Called by applyPaddleEvent ONLY when
// the standard resolution paths (custom_data → paddle_customer_id) miss on a
// subscription.created event. Returns null on any failure so the webhook
// falls through to the existing unknown_user response (Paddle stops retrying;
// we'd lose visibility but the event is at least audited in
// paddle_webhook_events).
function makeEmailResolver(): EmailResolver {
  return async (customerId) => {
    let email: string | null;
    try {
      email = await fetchPaddleCustomerEmail(customerId);
    } catch (err) {
      console.warn(
        '[hosted-backup paddle webhook] fetchPaddleCustomerEmail failed',
        { customerId, err: err instanceof Error ? err.message : String(err) },
      );
      return null;
    }
    if (!email) {
      console.warn(
        '[hosted-backup paddle webhook] Paddle customer has no email',
        { customerId },
      );
      return null;
    }
    return ensurePreAccount(email);
  };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.PADDLE_WEBHOOK_SECRET;
  if (!secret) {
    console.error(
      '[hosted-backup paddle webhook] PADDLE_WEBHOOK_SECRET is not set',
    );
    return ok(
      { success: false, error: { code: 'SERVER_MISCONFIGURED' } },
      500,
    );
  }

  const rawBody = await req.text();

  try {
    verifyPaddleSignature({
      header: req.headers.get('paddle-signature'),
      rawBody,
      secret,
    });
  } catch (err) {
    if (err instanceof PaddleSignatureError) {
      return ok(
        {
          success: false,
          error: { code: 'PADDLE_SIGNATURE_INVALID', message: err.message },
        },
        401,
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
        error: { code: 'BAD_REQUEST', message: 'invalid JSON' },
      },
      400,
    );
  }

  if (typeof event.event_id !== 'string' || event.event_id.length === 0) {
    return ok(
      {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'event_id is required' },
      },
      400,
    );
  }
  if (typeof event.event_type !== 'string') {
    return ok(
      {
        success: false,
        error: { code: 'BAD_REQUEST', message: 'event_type is required' },
      },
      400,
    );
  }

  // Idempotency: same event_id must not be processed twice.
  let isFresh = false;
  try {
    isFresh = await recordPaddleEventIfFresh({
      eventId: event.event_id,
      eventType: event.event_type,
    });
  } catch (err) {
    // If the idempotency insert blows up (e.g. DB hiccup), let Paddle retry.
    console.error('[hosted-backup paddle webhook] idempotency insert failed:', err);
    return ok(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'transient failure' },
      },
      500,
    );
  }

  if (!isFresh) {
    return ok({ ok: true, deduped: true }, 200);
  }

  if (!isHandledEvent(event.event_type)) {
    console.warn(
      '[hosted-backup paddle webhook] ignoring unhandled event_type:',
      event.event_type,
    );
    await markPaddleEventProcessed(event.event_id);
    return ok({ ok: true, ignored: true, event_type: event.event_type }, 200);
  }

  let result;
  try {
    result = await applyPaddleEvent(event, {
      resolveByEmail: makeEmailResolver(),
    });
  } catch (err) {
    console.error('[hosted-backup paddle webhook] apply threw:', err);
    return ok(
      {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'transient failure' },
      },
      500,
    );
  }

  await markPaddleEventProcessed(event.event_id);

  if (result.kind === 'unknown_user') {
    // Subscription event for a user we don't have on file yet. Return 200 so
    // Paddle stops retrying immediately; if our row appears later we'll get
    // a subsequent event we can act on. (Paddle's retry policy means we'd
    // get this event again on transient errors anyway.)
    console.warn(
      '[hosted-backup paddle webhook] unknown user for customer_id; recording as processed',
      { event_id: event.event_id, event_type: event.event_type },
    );
    return ok({ ok: true, unknown_user: true }, 200);
  }
  if (result.kind === 'ignored') {
    return ok({ ok: true, ignored: true, reason: result.reason }, 200);
  }

  // If we resolved via the email-fallback path, fire the right follow-up
  // email. Failures here log + continue — we don't want Brevo hiccups to
  // make Paddle retry the webhook (which would mint duplicate claim
  // tokens).
  if (result.preAccountFlow) {
    try {
      await dispatchPostResolveEmail(result.userId);
    } catch (err) {
      console.error(
        '[hosted-backup paddle webhook] follow-up email dispatch threw',
        err,
      );
    }
  }

  return ok({ ok: true, userId: result.userId, status: result.status }, 200);
}

// Looks at the resolved user. If they have no auth_credentials, they're a
// pre-account — mint a claim token + send the claim email. Otherwise they're
// a real existing user who happened to buy via the marketing CTA — send the
// FYI email.
async function dispatchPostResolveEmail(userId: string): Promise<void> {
  const hasCreds = await userHasAuthCredentials(userId);
  // We need the email + (for FYI) the subscription detail. Both live on
  // the rows we just touched.
  const sub = await getSubscriptionByUserId(userId);
  if (!sub) {
    // Should not happen — applyPaddleEvent just upserted the row. Log and
    // bail.
    console.warn(
      '[hosted-backup paddle webhook] post-resolve email: subscription missing',
      { userId },
    );
    return;
  }
  // userHasAuthCredentials told us whether the user is a pre-account; we
  // still need their email. Fetch the users row directly (avoids adding
  // another helper).
  const userRow = await fetchUserEmail(userId);
  if (!userRow) {
    console.warn(
      '[hosted-backup paddle webhook] post-resolve email: user row missing',
      { userId },
    );
    return;
  }
  if (!hasCreds) {
    const { token } = await mintClaimToken({ userId, email: userRow.email });
    const rendered = renderClaimEmail({ email: userRow.email, token });
    const sendResult = await sendTransactionalEmail({
      to: userRow.email,
      subject: rendered.subject,
      htmlContent: rendered.htmlContent,
      textContent: rendered.textContent,
    });
    if (!sendResult.success) {
      console.warn(
        '[hosted-backup paddle webhook] claim email send failed',
        { userId, error: sendResult.error },
      );
    }
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
    console.warn(
      '[hosted-backup paddle webhook] fyi email send failed',
      { userId, error: sendResult.error },
    );
  }
}

async function fetchUserEmail(userId: string): Promise<{ email: string } | null> {
  // Small ad-hoc query — pulling in findUserById from db.ts would also work,
  // but it returns a richer shape than we need. Keep it local.
  const { findUserById } = await import('@/lib/hosted-backup/db');
  const row = await findUserById(userId);
  return row ? { email: row.email } : null;
}
