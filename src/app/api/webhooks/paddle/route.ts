import { NextRequest, NextResponse } from 'next/server';
import {
  PaddleSignatureError,
  verifyPaddleSignature,
} from '@/lib/license/paddle';
import { withApiVersion } from '@/lib/hosted-backup/api-version';
import {
  recordPaddleEventIfFresh,
  markPaddleEventProcessed,
} from '@/lib/hosted-backup/db';
import {
  applyPaddleEvent,
  isHandledEvent,
  type PaddleSubscriptionEvent,
} from '@/lib/hosted-backup/subscriptions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function ok(body: Record<string, unknown>, status = 200): NextResponse {
  return withApiVersion(NextResponse.json(body, { status }));
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
    result = await applyPaddleEvent(event);
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
  return ok({ ok: true, userId: result.userId, status: result.status }, 200);
}
