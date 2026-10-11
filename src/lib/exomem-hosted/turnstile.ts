/**
 * Server-side Cloudflare Turnstile check for "Start with your email".
 *
 * What it prevents: a script mailing sign-in, start and waitlist emails to
 * addresses it chooses, and taking start links and waitlist places, from
 * many networks at once (the per-network rate limit alone cannot stop that).
 * What it costs when it fires wrongly: a real visitor sees the start form fail
 * and must solve the challenge again. If Cloudflare cannot be reached, the
 * request continues under the rate limits instead, so an outage at Cloudflare
 * never locks people out of their accounts.
 *
 * Configuration: the secret is `EXOMEM_TURNSTILE_SECRET_KEY` and the browser
 * widget's site key is `NEXT_PUBLIC_EXOMEM_TURNSTILE_SITE_KEY`. Development
 * and tests use Cloudflare's documented test keys.
 */

import { ExomemHostedError } from "./errors";
import { exomemPublicBaseUrlFromEnv } from "./public-origin";

export const TURNSTILE_SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
export const TURNSTILE_START_ACTION = "start";
const SITEVERIFY_TIMEOUT_MS = 3_000;
// Cloudflare documents tokens of at most 2048 characters.
const MAX_TOKEN_LENGTH = 2048;

/**
 * Cloudflare's documented test secret keys (always passes, always fails,
 * token already spent). Their siteverify answers carry a fixed hostname and
 * no action, so the hostname and action checks cannot apply to them. A
 * deployment configured with one of these keys has no bot check at all, with
 * or without those two checks.
 */
const TURNSTILE_TEST_SECRET_KEYS = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

/**
 * Siteverify error codes that mean our own configuration is wrong, from
 * Cloudflare's documented error-code list.
 */
const CONFIGURATION_ERROR_CODES = new Set(["missing-input-secret", "invalid-input-secret"]);

export type TurnstileVerdict = "passed" | "failed" | "unavailable";

export type TurnstileDependencies = {
  fetch: typeof fetch;
  secretKey: string | undefined;
  expectedHostname: () => string;
};

function defaults(): TurnstileDependencies {
  return {
    fetch: (...args) => fetch(...args),
    secretKey: process.env.EXOMEM_TURNSTILE_SECRET_KEY,
    expectedHostname: () => new URL(exomemPublicBaseUrlFromEnv()).hostname,
  };
}

/**
 * A missing or rejected secret is our misconfiguration, not a visitor's
 * failure. Every start request fails with this until it is fixed: the
 * alternative is running without the bot check and nobody noticing.
 */
function turnstileUnconfigured(): ExomemHostedError {
  return new ExomemHostedError({
    code: "TURNSTILE_UNCONFIGURED",
    status: 503,
    message: "the sign-in challenge is not configured",
    retryable: true,
  });
}

/**
 * Checks one widget token. The verdict depends only on the token, never on
 * the email address it came with.
 */
export async function verifyTurnstileToken(
  input: { token: unknown; remoteIp: string | null },
  dependencies: Partial<TurnstileDependencies> = {}
): Promise<TurnstileVerdict> {
  const deps = { ...defaults(), ...dependencies };
  const secret = deps.secretKey;
  if (!secret) throw turnstileUnconfigured();
  if (
    typeof input.token !== "string" ||
    input.token.length === 0 ||
    input.token.length > MAX_TOKEN_LENGTH
  ) {
    return "failed";
  }

  let body: Record<string, unknown>;
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
    if (!response.ok) return "unavailable";
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    return "unavailable";
  }
  if (typeof body !== "object" || body === null) return "unavailable";

  const errorCodes = Array.isArray(body["error-codes"])
    ? body["error-codes"].filter((code): code is string => typeof code === "string")
    : [];
  if (errorCodes.some((code) => CONFIGURATION_ERROR_CODES.has(code))) {
    throw turnstileUnconfigured();
  }
  if (body.success !== true) {
    return errorCodes.includes("internal-error") ? "unavailable" : "failed";
  }
  if (TURNSTILE_TEST_SECRET_KEYS.has(secret)) return "passed";
  // A token minted on another site, or by another form of ours, is not a
  // pass here even though Cloudflare accepted it.
  if (body.action !== TURNSTILE_START_ACTION) return "failed";
  if (body.hostname !== deps.expectedHostname()) return "failed";
  return "passed";
}
