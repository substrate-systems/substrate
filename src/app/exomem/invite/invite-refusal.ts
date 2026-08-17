// What a refused invitation should say, and whether the same link is worth
// pressing again.
//
// Kept apart from the component for the same reason as `home-sections.ts` and
// `consent-audience.ts`: the copy IS the defect. Every failure used to render
// "We could not open this invitation. Ask the person who invited you for a
// fresh link." When Hosted has no live contract cohort, that is false twice
// over — the invitation is valid and unconsumed, and a fresh link changes
// nothing — and it sat directly above a response saying the opposite.
//
// Expressing the choice as data lets it be asserted without rendering, so what
// the tests pin cannot drift from what ships.

export type InviteRefusal = {
  /** The sentence above the server's own message. */
  lede: string;
  /** Whether to offer the same invitation again rather than send them away. */
  offerRetry: boolean;
};

/**
 * `retryable` comes straight from the error envelope, and it is the only signal
 * that separates the two cases. A spent, revoked or malformed invitation is
 * final and needs a new link. A service that is not admitting right now needs
 * the same link, later — so sending that person back to whoever invited them
 * wastes both their time and an invitation.
 */
export function inviteRefusal(retryable: boolean): InviteRefusal {
  return retryable
    ? {
        lede: "Your invitation is fine — Exomem itself is not ready to open it yet.",
        offerRetry: true,
      }
    : {
        lede: "We could not open this invitation. Ask the person who invited you for a fresh link.",
        offerRetry: false,
      };
}
