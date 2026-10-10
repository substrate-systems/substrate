import type { Metadata } from "next";
import { PaddleTransactionOpener } from "@/components/PaddleTransactionOpener";
import { loadExomemCloudPrice } from "@/lib/exomem-hosted/paddle-price";
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

export default async function ExomemHomePage() {
  const price = await loadExomemCloudPrice();
  return (
    <PrivateShell>
      <PaddleTransactionOpener validationEndpoint="/api/exomem/billing/checkout" />
      <HomeClient serverUrl={`${exomemPublicBaseUrlFromEnv()}/api/exomem/mcp/v1`} price={price} />
    </PrivateShell>
  );
}
