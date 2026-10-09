// Which controls the consent page offers, and in what order.
//
// Kept apart from the component because the ordering IS the defect this module
// exists to prevent: the reviewer credential form used to sit above the path an
// invited person actually needed, and "Continue" was offered to visitors with no
// session, for whom it can only end in access_denied. Expressing the decision as
// data lets it be asserted directly, without rendering.
import type { ConsentStep } from "./consent-state";

export type ConsentSection =
  | "connect"
  | "sign-in"
  | "invitation"
  | "reviewer"
  | "subscribe"
  | "payment-failed"
  | "ended"
  | "paused"
  | "suspended";

export function consentSections(input: {
  step: ConsentStep;
  reviewerEnabled: boolean;
}): ConsentSection[] {
  switch (input.step) {
    // Signing in comes first: most visitors with no session on this device already
    // have an Exomem. The invitation path is for new people, and reviewer access is
    // an internal path, so it stays last.
    case "sign-in":
      return ["sign-in", "invitation", ...(input.reviewerEnabled ? (["reviewer"] as const) : [])];
    case "connect-read-only":
      return ["payment-failed", "connect"];
    case "subscribe":
    case "connect":
    case "ended":
    case "paused":
    case "suspended":
      return [input.step];
  }
}
