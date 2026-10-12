import type { Metadata } from "next";
import { cloudExportsEnabled } from "@/lib/exomem-hosted/cloud-exports";
import { exomemCheckoutPriceId } from "@/lib/exomem-hosted/paddle-config";
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
      <HomeClient priceId={exomemCheckoutPriceId()} exportOffered={cloudExportsEnabled()} />
    </main>
  );
}
