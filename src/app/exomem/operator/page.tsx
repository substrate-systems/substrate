import type { Metadata } from "next";
import home from "../home/home.module.css";
import OperatorClient from "./operator-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Exomem alpha operator",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ExomemOperatorPage() {
  return (
    <main className={`${home.page} brand-exomem`}>
      <OperatorClient />
    </main>
  );
}
