export type SendTransactionalEmailInput = {
  to: string;
  subject: string;
  htmlContent: string;
  textContent: string;
};

export type SendTransactionalEmailResult = {
  success: boolean;
  error?: string;
  messageId?: string;
};

type BrevoSuccessResponse = {
  messageId?: string;
};

type BrevoErrorResponse = {
  code?: string;
  message?: string;
};

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const DEFAULT_SENDER_EMAIL = 'licenses@substratesystems.io';
const SENDER_NAME = 'Substrate Systems';

export async function sendTransactionalEmail(
  input: SendTransactionalEmailInput,
): Promise<SendTransactionalEmailResult> {
  const { to, subject, htmlContent, textContent } = input;

  if (!to || !subject || !htmlContent || !textContent) {
    throw new Error(
      'sendTransactionalEmail: to, subject, htmlContent, and textContent are required',
    );
  }

  if (process.env.NODE_ENV === 'test') {
    return { success: true, messageId: 'test-noop' };
  }

  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    throw new Error('BREVO_API_KEY is not set');
  }

  const senderEmail = process.env.BREVO_SENDER_EMAIL ?? DEFAULT_SENDER_EMAIL;
  const sender = { email: senderEmail, name: SENDER_NAME };

  let res: Response;
  try {
    res = await fetch(BREVO_API_URL, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender,
        replyTo: sender,
        to: [{ email: to }],
        subject,
        htmlContent,
        textContent,
      }),
    });
  } catch (err) {
    return {
      success: false,
      error: `brevo request failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!res.ok) {
    let detail = '';
    try {
      const body = (await res.json()) as BrevoErrorResponse;
      detail = body.message ?? body.code ?? '';
    } catch {
      detail = await res.text().catch(() => '');
    }
    return {
      success: false,
      error: `brevo error ${res.status}: ${detail || res.statusText}`,
    };
  }

  let messageId: string | undefined;
  try {
    const body = (await res.json()) as BrevoSuccessResponse;
    messageId = body.messageId;
  } catch {
    // brevo returns JSON on success; swallow if absent so we still report success
  }

  return { success: true, messageId };
}
