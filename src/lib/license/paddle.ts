import { createHmac, timingSafeEqual } from 'node:crypto';

export class PaddleSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PaddleSignatureError';
  }
}

export function verifyPaddleSignature(params: {
  header: string | null;
  rawBody: string;
  secret: string;
  toleranceSeconds?: number;
}): void {
  const { header, rawBody, secret, toleranceSeconds = 5 * 60 } = params;
  if (!header) {
    throw new PaddleSignatureError('missing Paddle-Signature header');
  }
  const parts = Object.fromEntries(
    header.split(';').map((p) => {
      const [k, v] = p.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) {
    throw new PaddleSignatureError('malformed Paddle-Signature header');
  }
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum)) {
    throw new PaddleSignatureError('invalid timestamp');
  }
  const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum);
  if (ageSeconds > toleranceSeconds) {
    throw new PaddleSignatureError('timestamp outside tolerance');
  }
  const expected = createHmac('sha256', secret)
    .update(`${ts}:${rawBody}`)
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(h1, 'hex');
  if (
    expectedBuf.length !== providedBuf.length ||
    !timingSafeEqual(expectedBuf, providedBuf)
  ) {
    throw new PaddleSignatureError('signature mismatch');
  }
}

export type PaddleTransactionCompleted = {
  event_type: string;
  data: {
    id: string;
    customer_id?: string;
    customer?: { email?: string };
    details?: { customer?: { email?: string } };
  };
};

export function extractTransactionFields(event: unknown): {
  transactionId: string;
  email: string;
} {
  const e = event as PaddleTransactionCompleted;
  const transactionId = e?.data?.id;
  const email =
    e?.data?.customer?.email ?? e?.data?.details?.customer?.email ?? '';
  if (!transactionId) {
    throw new Error('event missing data.id');
  }
  if (!email) {
    throw new Error('event missing customer email');
  }
  return { transactionId, email };
}
