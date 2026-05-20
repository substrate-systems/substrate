/**
 * Single source of truth for the Paddle API base URL and authenticated HTTP
 * calls. All server-side Paddle interactions (checkout, subscription cancel,
 * customer lookup) route through here so a single env var swaps the entire
 * service between sandbox and production.
 *
 * `PADDLE_ENVIRONMENT` controls the base URL:
 *   - "production" → https://api.paddle.com
 *   - anything else, including unset → https://sandbox-api.paddle.com
 *
 * The default-to-sandbox stance is deliberate: production must be explicitly
 * opted in by setting the env var.
 */

const PROD_BASE = 'https://api.paddle.com';
const SANDBOX_BASE = 'https://sandbox-api.paddle.com';

export function paddleApiBaseUrl(): string {
  return process.env.PADDLE_ENVIRONMENT === 'production'
    ? PROD_BASE
    : SANDBOX_BASE;
}

export class PaddleApiError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`paddle api ${status}: ${body || '<empty body>'}`);
    this.name = 'PaddleApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Authenticated fetch against the Paddle API. Prefixes the path with the
 * base URL from `paddleApiBaseUrl()` and attaches the bearer token.
 * Caller is responsible for parsing the body. Non-2xx responses are NOT
 * thrown here — callers vary in whether they need the response or just
 * fire-and-forget — but a helper `assertOk` is exposed for the common case.
 */
export async function paddleFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const apiKey = process.env.PADDLE_API_KEY;
  if (!apiKey) {
    throw new Error('PADDLE_API_KEY is not set');
  }
  const url = `${paddleApiBaseUrl()}${path.startsWith('/') ? '' : '/'}${path}`;
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${apiKey}`);
  headers.set('accept', 'application/json');
  if (init.body && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return fetch(url, { ...init, headers });
}

export async function assertOk(res: Response): Promise<void> {
  if (res.ok) return;
  const body = await res.text().catch(() => '');
  throw new PaddleApiError(res.status, body);
}
