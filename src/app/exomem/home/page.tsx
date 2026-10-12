import type { Metadata } from "next";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { cloudHomeChannelEnabled } from "@/lib/exomem-hosted/cloud-home-mcp";
import { exomemCheckoutPriceId } from "@/lib/exomem-hosted/paddle-config";
import { statusPageUrl } from "../_journey/status-page";
import HomeClient from "./home-client";
import styles from "./home.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Your Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ExomemHomePage() {
  return (
    <main className={`${styles.page} brand-exomem`}>
      <HomeClient
        priceId={exomemCheckoutPriceId()}
        exportOffered={cloudExportsEnabled()}
        channelOn={cloudHomeChannelEnabled()}
        statusPageUrl={statusPageUrl()}
      />
    </main>
  );
}
