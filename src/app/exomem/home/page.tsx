import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { cloudHomeChannelEnabled } from "@/lib/exomem-hosted/cloud-home-mcp";
import { cloudViewerEnabled } from "@/lib/exomem-hosted/cloud-viewer";
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

export default async function ExomemHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returned = (await searchParams)._ptxn;
  if (typeof returned === "string") redirect(`/exomem/setup?_ptxn=${encodeURIComponent(returned)}`);
  return (
    <main className={`${styles.page} brand-exomem`} data-alive-surface>
      <HomeClient
        priceId={exomemCheckoutPriceId()}
        exportOffered={cloudExportsEnabled()}
        channelOn={cloudHomeChannelEnabled()}
        statusPageUrl={statusPageUrl()}
        viewerOffered={cloudViewerEnabled()}
      />
    </main>
  );
}
