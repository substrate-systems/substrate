"use client";

import {
  CUSTOM_SPONSOR_MAILTO,
  SPONSORS_LIVE,
  supportTiers,
  type SupportTier,
} from "@/lib/support-tiers";
import { c } from "../_shared";

/**
 * Contribution choices for "Support Endstate".
 *
 * Each amount is a one-time sponsorship on the Substrate Systems GitHub
 * Sponsors profile — a plain outbound link, not a checkout we operate. Until
 * the profile is approved the cards render in full without a link, because
 * pointing at an unapproved profile is worse than saying so. The Custom Project
 * Sponsor card is a mail link either way.
 */
export function SupportTiers() {
  const tiers = supportTiers();

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {tiers.map((tier) => (
        <TierCard key={tier.id} tier={tier}>
          {SPONSORS_LIVE ? (
            <a
              href={tier.sponsorsUrl}
              target="_blank"
              rel="noopener"
              className="block w-full text-center py-2.5 rounded-lg font-semibold hover:opacity-88 transition-opacity duration-200"
              style={{
                background: c.elevated,
                color: c.text,
                border: `1px solid ${c.borderAccent}`,
                fontSize: "0.95rem",
                textDecoration: "none",
              }}
            >
              Contribute {tier.amount}
            </a>
          ) : (
            <p
              data-support-interim
              style={{
                fontSize: "0.85rem",
                color: c.textMuted,
                lineHeight: 1.6,
                margin: 0,
              }}
            >
              Support is moving to GitHub Sponsors — live within days.
            </p>
          )}
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
            background: "rgba(200, 121, 65, 0.12)",
            color: c.text,
            border: `1px solid rgba(200, 121, 65, 0.5)`,
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
  const isCustom = tier.id === "custom";

  return (
    <div
      className="rounded-2xl p-5 sm:p-6 flex flex-col"
      style={{
        border: `1px solid ${isCustom ? "rgba(200, 121, 65, 0.5)" : c.border}`,
        background: isCustom ? "rgba(200, 121, 65, 0.06)" : c.card,
      }}
    >
      <p
        style={{
          fontFamily: "var(--font-jetbrains-mono), monospace",
          fontSize: "0.7rem",
          fontWeight: 500,
          color: isCustom ? c.copper : c.teal,
          letterSpacing: "0.1em",
          textTransform: "uppercase",
          marginBottom: "0.75rem",
        }}
      >
        Voluntary support
      </p>
      <h3 style={{ fontSize: "1.05rem", fontWeight: 600, color: c.text, marginBottom: "0.35rem" }}>
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
