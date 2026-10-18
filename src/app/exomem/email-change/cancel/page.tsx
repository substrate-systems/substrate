import type { Metadata } from "next";
import EmailChangeClient from "../email-change-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Stop your Exomem email change",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function CancelEmailChangePage() {
  return <EmailChangeClient action="cancel" />;
}
