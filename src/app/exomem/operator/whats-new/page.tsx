import type { Metadata } from "next";
import home from "../../home/home.module.css";
import WhatsNewClient from "./whats-new-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Evermatter monthly What's new",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ExomemOperatorWhatsNewPage() {
  return (
    <main className={`${home.page} brand-exomem`}>
      <WhatsNewClient />
    </main>
  );
}
