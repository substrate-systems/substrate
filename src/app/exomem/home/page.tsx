import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { cloudHomeChannelEnabled } from "@/lib/exomem-hosted/cloud-home-mcp";
import { cloudViewerEnabled } from "@/lib/exomem-hosted/cloud-viewer";
import { exomemCheckoutPriceId } from "@/lib/exomem-hosted/paddle-config";
import { appPagePathOn } from "@/lib/exomem-hosted/public-origin";
import { statusPageUrl } from "@/lib/exomem-hosted/status-page-url";
import HomeClient from "./home-client";
import styles from "./home.module.css";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Your Evermatter",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ExomemHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const returned = (await searchParams)._ptxn;
  if (typeof returned === "string") {
    const setup = `/exomem/setup?_ptxn=${encodeURIComponent(returned)}`;
    redirect(appPagePathOn((await headers()).get("host"), setup));
  }
  return (
    <main className={`${styles.page} brand-exomem`} data-alive-surface>
      <HomeClient
        priceId={exomemCheckoutPriceId()}
        exportOffered={cloudExportsEnabled()}
        accessLogOffered={process.env.EXOMEM_CLOUD_ACCESS_LOG_ENABLED === "true"}
        channelOn={cloudHomeChannelEnabled()}
        storageOffered={process.env.EXOMEM_CLOUD_STORAGE_ENABLED === "true"}
        statusPageUrl={statusPageUrl()}
        viewerOffered={cloudViewerEnabled()}
      />
    </main>
  );
}
