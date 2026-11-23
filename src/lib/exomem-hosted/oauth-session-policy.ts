import type { EnvironmentSource } from "./cloud-config";

export type OAuthSessionPolicy = {
  /** Days a refresh token stays valid unused. Every rotation renews the window. */
  refreshIdleDays: number;
  /** Days from sign-in at which a token family ends, however active it is. */
  sessionMaxDays: number;
  /**
   * Seconds after a refresh token is spent in which its own client may present
   * it again and get a fresh pair. 0 turns the interval off; a spent token
   * presented after it is refused without revoking the family.
   */
  refreshReuseSeconds: number;
};

type Bound = {
  variable: string;
  /** The value when the variable is unset. */
  fallback: number;
  /** The value when the variable is set but is not a whole number of at least `min`. */
  invalid: number;
  min: number;
  max: number;
};

// Each maximum is the longest the operator may choose, not a target; the
// fallback is the shipped default. They are policy bounds, so they live here
// once and the runbook table repeats them.
//
// - Idle: a refresh token unused for a quarter is more likely lost than waiting.
// - Session: re-authenticating at least every two years bounds any credential
//   that kept rotating unnoticed.
// - Reuse: long enough for parallel sessions that share one stored credential
//   and present a token rotated days earlier; a spent token's fan-out is
//   capped only as a loop guard, since every minted token can fan out again
//   and only family or grant revocation bounds a thief.
//   A malformed value reads as 0, not as the default: a reuse interval widens
//   what a stolen token can do, and an operator who wrote `off` or `-1` wants
//   strict replay. That strictness is not cheap: with no grace, a spent
//   token's first re-presentation is refused, and clients that clear their
//   store on invalid_grant sign every parallel session out.
const BOUNDS = {
  refreshIdleDays: {
    variable: "EXOMEM_OAUTH_REFRESH_IDLE_DAYS",
    fallback: 30,
    invalid: 30,
    min: 1,
    max: 90,
  },
  sessionMaxDays: {
    variable: "EXOMEM_OAUTH_SESSION_MAX_DAYS",
    fallback: 365,
    invalid: 365,
    min: 1,
    max: 730,
  },
  refreshReuseSeconds: {
    variable: "EXOMEM_OAUTH_REFRESH_REUSE_SECONDS",
    // Seven days covers a session that returns with a token rotated while it
    // was away; the maximum is a month, the default idle window.
    fallback: 604800,
    invalid: 0,
    min: 0,
    max: 2592000,
  },
} as const satisfies Record<keyof OAuthSessionPolicy, Bound>;

// A bad value must not fail sign-in for everyone, so it reads as the bound's
// `invalid` value and the operator sees a warning. A value above the maximum
// reads as the maximum, which is the nearest value the operator is allowed to
// choose.
function boundedWholeNumber(env: EnvironmentSource, bound: Bound): number {
  const raw = env[bound.variable]?.trim();
  if (!raw) return bound.fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < bound.min) {
    console.warn({
      event: "exomem_oauth_session_config_invalid",
      variable: bound.variable,
      reason: "not_a_whole_number_in_range",
      used: bound.invalid,
    });
    return bound.invalid;
  }
  if (value > bound.max) {
    console.warn({
      event: "exomem_oauth_session_config_invalid",
      variable: bound.variable,
      reason: "above_maximum",
      used: bound.max,
    });
    return bound.max;
  }
  return value;
}

export function loadOAuthSessionPolicy(env: EnvironmentSource = process.env): OAuthSessionPolicy {
  return {
    refreshIdleDays: boundedWholeNumber(env, BOUNDS.refreshIdleDays),
    sessionMaxDays: boundedWholeNumber(env, BOUNDS.sessionMaxDays),
    refreshReuseSeconds: boundedWholeNumber(env, BOUNDS.refreshReuseSeconds),
  };
}
