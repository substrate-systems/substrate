/**
 * Voluntary project support tiers for Endstate.
 *
 * "Support Endstate" is a contribution, not a plan. It creates no licence key,
 * no entitlement, no feature flag, and no recurring obligation. The only thing
 * a contribution changes is the opt-in name on the supporters page. Keep it
 * that way: the moment a tier promises functionality, it stops being support
 * and starts being a paid product, which the Endstate Principles rule out.
 *
 * Contributions are taken through GitHub Sponsors rather than a checkout we
 * operate. The amounts are one-time only — a recurring sponsorship would be the
 * recurring obligation the copy promises does not exist — and each tier links
 * straight at its amount on the org profile.
 */

/**
 * Whether the GitHub Sponsors profile is approved and accepting contributions.
 *
 * While false the tier cards render in full but their buttons are replaced by a
 * single line saying support is moving, because a link to an unapproved profile
 * is a dead end. Flipping this to true is the whole of the go-live change.
 */
export const SPONSORS_LIVE = false;

const SPONSORS_ORG = "https://github.com/sponsors/substrate-systems";

export type SupportTierId = "supporter" | "founding-supporter" | "patron";

export type SupportTier = {
  id: SupportTierId;
  name: string;
  amount: string;
  blurb: string;
  /** One-time sponsorship at this tier's amount, on the Substrate Systems profile. */
  sponsorsUrl: string;
};

const TIERS: ReadonlyArray<SupportTier> = [
  {
    id: "supporter",
    name: "Supporter",
    amount: "$10",
    blurb: "A small, one-time contribution towards the work.",
    sponsorsUrl: `${SPONSORS_ORG}?frequency=one-time&amount=10`,
  },
  {
    id: "founding-supporter",
    name: "Founding Supporter",
    amount: "$29",
    blurb: "For people backing Endstate early, while it is still being shaped.",
    sponsorsUrl: `${SPONSORS_ORG}?frequency=one-time&amount=29`,
  },
  {
    id: "patron",
    name: "Patron",
    amount: "$89",
    blurb: "The largest standing contribution, for people who want this to keep going.",
    sponsorsUrl: `${SPONSORS_ORG}?frequency=one-time&amount=89`,
  },
];

/** Every contribution amount offered on the Sponsors profile. */
export function supportTiers(): SupportTier[] {
  return TIERS.map((tier) => ({ ...tier }));
}

/** Lowest contribution amount, for "from $X" copy. */
export function lowestSupportAmount(): string {
  return TIERS[0].amount;
}

/**
 * The Custom Project Sponsor path. Deliberately a mail link and not an
 * arbitrary-amount sponsorship: a larger contribution is a conversation, not a
 * form field, and no new intake surface exists to route it through.
 */
export const CUSTOM_SPONSOR_MAILTO =
  "mailto:founder@substratesystems.io" +
  `?subject=${encodeURIComponent("Custom Project Sponsor — Endstate")}` +
  `&body=${encodeURIComponent(
    [
      "Hello Hugo,",
      "",
      "I would like to sponsor Endstate. A few details:",
      "",
      "- Who is sponsoring (person or organisation):",
      "- Roughly what amount or cadence I have in mind:",
      "- What I care about in the project:",
      "- Whether I would like public recognition (optional):",
      "",
      "Thanks,",
    ].join("\n")
  )}`;
