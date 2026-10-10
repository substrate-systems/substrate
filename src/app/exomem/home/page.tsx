import type { Metadata } from "next";
import { PaddleTransactionOpener } from "@/components/PaddleTransactionOpener";
import { loadExomemPaddleConfig } from "@/lib/exomem-hosted/paddle-config";
import { exomemPublicBaseUrlFromEnv } from "@/lib/exomem-hosted/public-origin";
import { PrivateShell } from "../private-shell";
import HomeClient from "./home-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Your Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

// The subscribe card previews the price that checkout charges, so the browser
// gets the price ID only when checkout can run with the same client token.
function checkoutPriceId(): string | null {
  try {
    const config = loadExomemPaddleConfig();
    return config.paidCheckoutEnabled ? config.priceId : null;
  } catch {
    // The checkout route reports a broken configuration; Home shows no amount.
    return null;
  }
}

export default function ExomemHomePage() {
  return (
    <PrivateShell>
      <PaddleTransactionOpener validationEndpoint="/api/exomem/billing/checkout" />
      <HomeClient
        serverUrl={`${exomemPublicBaseUrlFromEnv()}/api/exomem/mcp/v1`}
        priceId={checkoutPriceId()}
      />
    </PrivateShell>
  );
}
