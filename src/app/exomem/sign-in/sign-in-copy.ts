// What the sign-in screen says once a link has been requested, and when it will
// let someone ask for another.
//
// The "sent" screen used to be terminal: "Check your email. You can close this
// page." There was no way back to the form and no mention that the link dies in
// fifteen minutes. Three ordinary things put a person in that dead end with no
// way out — a typo in the address, a link opened twenty minutes later, a mail
// that lands in spam — and every one of them ends at a screen that offers
// nothing.
//
// Resending is throttled here rather than left to the button, because the
// server's limit is silent by design: `requestMagicLink` returns the same
// `if_eligible_email_sent` whether it queued a mail or refused one, so an
// impatient person can spend the whole hourly allowance without a single
// visible difference. The cooldown is what keeps that from happening; it is not
// a security control and does not need to be, since the real limit is enforced
// server-side.
//
// Nothing here reveals whether an address has an Exomem. The copy stays
// conditional for the same reason the API response is opaque — but "we cannot
// say whether this address exists" is not the same as "we can say nothing", and
// the screen now names the two things a person can check for themselves.
//
// The supersession line exists because delivery is queued, not inline. A
// measured send took ~40 seconds from `delivery_state = pending` to `sent`,
// which is comfortably long enough to press resend while the first mail is
// still arriving. Every request invalidates the prior link, so the older mail
// then fails to redeem while looking perfectly current.

/** Mirrors `MAGIC_LINK_TTL_MS` in `src/lib/exomem-hosted/access.ts`. */
export const MAGIC_LINK_TTL_MINUTES = 15;

/**
 * How long the screen makes someone wait before offering another link.
 *
 * Short enough that a mistyped address is a small annoyance, long enough that
 * nobody burns `EXOMEM_RATE_LIMITS.magicLinkAccount` (5 per hour) by clicking.
 */
export const RESEND_COOLDOWN_SECONDS = 60;

export type SentScreen = {
  lede: string;
  /** States the expiry, so a link opened late is explicable rather than broken. */
  expiry: string;
  /**
   * Says that asking for another link retires the one already sent.
   *
   * Delivery is queued rather than inline and has been measured at ~40 seconds,
   * which is long enough that a person presses the resend button while their
   * mail is still in flight. Redeeming the older link then fails with
   * `SUPERSEDED_MAGIC_LINK`, and without this line the failure is unattributable:
   * the mail arrived, it looks current, and clicking it does nothing useful.
   */
  supersedes: string;
  /**
   * What to do when no mail arrives, without disclosing whether the address has
   * an Exomem. A mistyped address and a live one produce byte-identical
   * responses by design, so the screen cannot say "no account" — but it can name
   * the two things a person can actually check.
   */
  notArriving: string;
  /** Null while cooling down — the caller renders the countdown instead. */
  resendLabel: string | null;
  waitingLabel: string | null;
};

export function sentScreen(secondsUntilResend: number): SentScreen {
  const cooling = secondsUntilResend > 0;
  return {
    lede: "Check your email. If that address has an Exomem, a private sign-in link is on its way.",
    expiry: `The link works once and expires ${MAGIC_LINK_TTL_MINUTES} minutes after it is sent.`,
    supersedes: "Sending another link stops the previous one working, so use the newest email.",
    notArriving:
      "Nothing after a minute or two? Check your spam folder, and check the address matches the " +
      "one that received your invitation.",
    resendLabel: cooling ? null : "Send another link",
    waitingLabel: cooling ? `You can send another link in ${secondsUntilResend}s` : null,
  };
}

// A link that fails to redeem needs no screen of its own: the form is already
// what comes back, and the form is the recovery. What it did need was a message
// that says which of the two things happened and what to do — see the
// ACCESS_TOKEN_INVALID branch in `friendlyHostedError`.
