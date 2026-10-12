import type { Metadata } from "next";
import { PaddleTransactionOpener } from "@/components/PaddleTransactionOpener";
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
      {/* Paddle returns a checkout here with a transaction to open; it validates it first. */}
      <PaddleTransactionOpener validationEndpoint="/api/exomem/billing/checkout" />
      <HomeClient />
    </main>
  );
}
