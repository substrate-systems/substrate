"use client";

import { usePaddle } from "@/lib/paddle";
import {
  CUSTOM_SPONSOR_MAILTO,
  configuredSupportTiers,
  type SupportTier,
} from "@/lib/support-tiers";
import { BuyButton } from "../BuyButton";
import { c } from "../_shared";

/**
 * Contribution choices for "Support Endstate".
 *
 * Only tiers with a configured Paddle price render, so this ships before the
 * smaller prices exist and grows without a code change when they do. The
 * Custom Project Sponsor card always renders, because its path is a mail link
 * rather than a checkout.
 */
export function SupportTiers() {
  const { openSupportCheckout } = usePaddle();
  const tiers = configuredSupportTiers();

  return (
    <div className="grid sm:grid-cols-2 gap-4">
      {tiers.map((tier) => (
        <TierCard key={tier.id} tier={tier}>
          <BuyButton
            action={() => openSupportCheckout(tier)}
            completionLabel="Thank you — that genuinely helps."
            className="block w-full text-center py-2.5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
            style={{
              background: "transparent",
              color: c.text,
              border: `1px solid ${c.border}`,
              fontSize: "0.95rem",
            }}
          >
            Contribute {tier.amount}
          </BuyButton>
        </TierCard>
      ))}

      <TierCard
        tier={{
          id: "custom",
          name: "Custom Project Sponsor",
          amount: "By arrangement",
          blurb:
            "For a person or an organisation who wants to fund the project at a larger scale. Start a conversation and we will work out what makes sense.",
        }}
      >
        <a
          href={CUSTOM_SPONSOR_MAILTO}
          className="block w-full text-center py-2.5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
          style={{
            background: "transparent",
            color: c.text,
            border: `1px solid ${c.border}`,
            fontSize: "0.95rem",
            textDecoration: "none",
          }}
        >
          Get in touch
        </a>
      </TierCard>
    </div>
  );
}

type CardTier = Pick<SupportTier, "name" | "amount" | "blurb"> & { id: string };

function TierCard({ tier, children }: { tier: CardTier; children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl p-6 flex flex-col"
      style={{ border: `1px solid ${c.border}`, background: c.card }}
    >
      <h3 style={{ fontSize: "1rem", fontWeight: 600, color: c.text, marginBottom: "0.35rem" }}>
        {tier.name}
      </h3>
      <p
        style={{
          fontFamily: "var(--font-jetbrains-mono), monospace",
          fontSize: "0.8rem",
          color: c.textMuted,
          marginBottom: "0.9rem",
        }}
      >
        {tier.amount}
      </p>
      <p
        style={{
          fontSize: "0.9rem",
          color: c.textSec,
          lineHeight: 1.6,
          marginBottom: "1.5rem",
          flex: 1,
        }}
      >
        {tier.blurb}
      </p>
      {children}
    </div>
  );
}
