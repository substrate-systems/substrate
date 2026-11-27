import type { Metadata } from "next";
import UnsubscribeClient from "./unsubscribe-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Turn off the monthly update email",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function UnsubscribeMonthlyUpdatePage() {
  return <UnsubscribeClient />;
}
