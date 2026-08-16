// Which controls the consent page offers, and in what order.
//
// Kept apart from the component because the ordering IS the defect this module
// exists to prevent: the reviewer credential form used to sit above the path an
// invited person actually needed, and "Continue" was offered to visitors with no
// session, for whom it can only end in access_denied. Expressing the decision as
// data lets it be asserted directly, without rendering.
export type ConsentSection =
  | "connect"
  | "check-email"
  | "sign-in"
  | "paste-invitation"
  | "reviewer";

export function consentSections(input: {
  signedIn: boolean;
  reviewerEnabled: boolean;
}): ConsentSection[] {
  // A visitor who already has an Exomem needs exactly one thing, and none of the
  // sign-up paths apply to them.
  if (input.signedIn) return ["connect"];
  return [
    "check-email",
    "sign-in",
    "paste-invitation",
    ...(input.reviewerEnabled ? (["reviewer"] as const) : []),
  ];
}
