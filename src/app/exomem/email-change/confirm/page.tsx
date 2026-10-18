import type { Metadata } from "next";
import EmailChangeClient from "../email-change-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Confirm your new Exomem email",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ConfirmEmailChangePage() {
  return <EmailChangeClient action="confirm" />;
}
