/**
 * Server-side Cloudflare Turnstile check for "Start with your email".
 *
 * What it prevents: a script mailing sign-in, start and waitlist emails to
 * addresses it chooses, and taking start links and waitlist places, from
 * many networks at once. The per-network rate limit alone cannot stop that.
 * What it costs when it fires wrongly: a real visitor sees the start form
 * fail and must solve the challenge again.
 *
 * The check refuses a request only when Cloudflare says the token itself is
 * bad, or the token was made for another hostname or action. One posture
 * covers every case where the check cannot run: Cloudflare cannot be reached,
 * times out, throttles us or answers with any other error, the secret is
 * missing or Cloudflare rejects it, or production is configured with a
 * Cloudflare test secret. The request then continues under the per-address
 * and per-network rate limits, and the failure is logged at error level. The
 * bot check is then weaker until the cause is fixed. The alternative,
 * refusing every request, would lock every owner out of signing in over a
 * configuration or provider fault.
 *
 * Configuration: the secret is `EXOMEM_TURNSTILE_SECRET_KEY` and the browser
 * widget's site key is `NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY`. Development
 * and tests use Cloudflare's documented test keys.
 */

import { exomemPublicBaseUrlFromEnv } from "./public-origin";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_START_ACTION = "start";
const SITEVERIFY_TIMEOUT_MS = 3_000;
// Cloudflare documents tokens of at most 2048 characters.
const MAX_TOKEN_LENGTH = 2048;

/**
 * Cloudflare's documented test secret keys (always passes, always fails,
 * token already spent). Their siteverify answers carry a fixed hostname and
 * no action, so the hostname and action checks cannot apply to them.
 */
const TURNSTILE_TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

/**
 * The siteverify error codes that say the visitor's token itself is bad:
 * missing, invalid, or expired or already used. Only these, and a hostname or
 * action mismatch, refuse a request. The set is Cloudflare's documented,
 * closed error-code list; every other code (a rejected secret, a malformed
 * request, `internal-error`) means the check could not run.
 */
const TOKEN_ERROR_CODES = new Set([
  "missing-input-response",
  "invalid-input-response",
  "timeout-or-duplicate",
]);
// From the same documented list: our own secret is missing or wrong.
const SECRET_ERROR_CODES = new Set(["missing-input-secret", "invalid-input-secret"]);

export type TurnstileVerdict = "passed" | "failed" | "unavailable";

type UnavailableReason =
  | "secret_missing"
  | "secret_rejected"
  | "test_secret_in_production"
  | "unreachable"
  | "provider_error";

export type TurnstileDependencies = {
  fetch: typeof fetch;
  secretKey: string | undefined;
  /** Vercel's deployment environment; `production` refuses the test secrets. */
  deploymentEnvironment: string | undefined;
  expectedHostname: () => string;
  logError: (line: string) => void;
};

function defaults(): TurnstileDependencies {
  return {
    fetch: (...args) => fetch(...args),
    secretKey: process.env.EXOMEM_TURNSTILE_SECRET_KEY,
    deploymentEnvironment: process.env.VERCEL_ENV,
    expectedHostname: () => new URL(exomemPublicBaseUrlFromEnv()).hostname,
    logError: (line) => console.error(line),
  };
}

function unavailable(deps: TurnstileDependencies, reason: UnavailableReason): TurnstileVerdict {
  // Content-free: a fixed reason label, never the token or the address.
  deps.logError(`exomem-start: bot check unavailable (${reason}); rate limits only`);
  return "unavailable";
}

/**
 * Checks one widget token. The verdict depends only on the token and our
 * configuration, never on the email address it came with.
 */
export async function verifyTurnstileToken(
  input: { token: unknown; remoteIp: string | null },
  dependencies: Partial<TurnstileDependencies> = {}
): Promise<TurnstileVerdict> {
  const deps = { ...defaults(), ...dependencies };
  const secret = deps.secretKey;
  if (!secret) return unavailable(deps, "secret_missing");
  const testSecret = TURNSTILE_TEST_SECRET_KEYS.has(secret);
  if (testSecret && deps.deploymentEnvironment === "production") {
    return unavailable(deps, "test_secret_in_production");
  }
  if (
    typeof input.token !== "string" ||
    input.token.length === 0 ||
    input.token.length > MAX_TOKEN_LENGTH
  ) {
    return "failed";
  }

  let status: number;
  let body: unknown;
  try {
    const response = await deps.fetch(TURNSTILE_SITEVERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret,
        response: input.token,
        ...(input.remoteIp ? { remoteip: input.remoteIp } : {}),
      }),
      redirect: "error",
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });
    status = response.status;
    body = await response.json().catch(() => null);
  } catch {
    return unavailable(deps, "unreachable");
  }
  // Timeout, throttling and server errors: Cloudflare could not answer.
  if (status === 408 || status === 429 || status >= 500) return unavailable(deps, "unreachable");
  if (typeof body !== "object" || body === null) return unavailable(deps, "provider_error");
  const answer = body as Record<string, unknown>;

  const errorCodes = Array.isArray(answer["error-codes"])
    ? answer["error-codes"].filter((code): code is string => typeof code === "string")
    : [];
  if (errorCodes.some((code) => SECRET_ERROR_CODES.has(code))) {
    return unavailable(deps, "secret_rejected");
  }
  if (answer.success !== true || status < 200 || status >= 300) {
    return errorCodes.some((code) => TOKEN_ERROR_CODES.has(code))
      ? "failed"
      : unavailable(deps, "provider_error");
  }
  if (testSecret) return "passed";
  // A token minted on another site, or by another form of ours, is not a
  // pass here even though Cloudflare accepted it.
  if (answer.action !== TURNSTILE_START_ACTION) return "failed";
  if (answer.hostname !== deps.expectedHostname()) return "failed";
  return "passed";
}
