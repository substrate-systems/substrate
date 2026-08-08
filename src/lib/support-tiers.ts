/**
 * Voluntary project support tiers for Endstate.
 *
 * "Support Endstate" is a contribution, not a plan. It creates no licence key,
 * no entitlement, no feature flag, and no recurring obligation. The only thing
 * a contribution changes is the opt-in name on the supporters page. Keep it
 * that way: the moment a tier promises functionality, it stops being support
 * and starts being a paid product, which the Endstate Principles rule out.
 *
 * Tiers are config-driven so the page ships before every Paddle price exists.
 * A tier renders only when its price ID is configured; the rest simply do not
 * appear.
 *
 * Price IDs are resolved per call rather than captured at module load, so a
 * server that reads configuration after import sees it. Each one is still a
 * literal `process.env.NEXT_PUBLIC_*` member expression, because that is what
 * Next.js substitutes at build time — a computed lookup would resolve to
 * `undefined` in the browser bundle.
 */

export type SupportTierId = "supporter" | "founding-supporter" | "patron";

export type SupportTier = {
  id: SupportTierId;
  name: string;
  amount: string;
  blurb: string;
  /** Undefined until the price exists in Paddle; the tier stays hidden until then. */
  priceId: string | undefined;
};

const TIER_DEFINITIONS: ReadonlyArray<Omit<SupportTier, "priceId">> = [
  {
    id: "supporter",
    name: "Supporter",
    amount: "€10",
    blurb: "A small, one-time contribution towards the work.",
  },
  {
    id: "founding-supporter",
    name: "Founding Supporter",
    amount: "€29",
    blurb: "For people backing Endstate early, while it is still being shaped.",
  },
  {
    id: "patron",
    name: "Patron",
    amount: "€89",
    blurb: "The largest standing contribution, for people who want this to keep going.",
  },
];

function priceIdFor(id: SupportTierId): string | undefined {
  switch (id) {
    case "supporter":
      return process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_10;
    case "founding-supporter":
      return process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_SUPPORT_29;
    case "patron":
      // Deliberately retained identifier: every existing €89 support record is
      // attached to this price, so its env var keeps the original name even
      // though the public tier is now called Patron. See docs/naming.md.
      return process.env.NEXT_PUBLIC_PADDLE_PRICE_ID_ENDSTATE_SUPPORTER;
  }
}

/** Every defined tier, whether or not Paddle can charge for it yet. */
export function supportTiers(): SupportTier[] {
  return TIER_DEFINITIONS.map((tier) => ({ ...tier, priceId: priceIdFor(tier.id) }));
}

/** Contribution amounts that Paddle can actually take money for right now. */
export function configuredSupportTiers(): SupportTier[] {
  return supportTiers().filter((tier) => Boolean(tier.priceId));
}

/** Lowest configured amount, for "from €X" copy. Null when nothing is configured. */
export function lowestConfiguredSupportAmount(): string | null {
  return configuredSupportTiers()[0]?.amount ?? null;
}

/**
 * The Custom Project Sponsor path. Deliberately a mail link and not an
 * arbitrary-amount checkout: a larger contribution is a conversation, not a
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
