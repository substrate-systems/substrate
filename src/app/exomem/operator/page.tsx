import type { Metadata } from "next";
import { loadExomemCloudPrice } from "@/lib/exomem-hosted/paddle-price";
import { PrivateShell } from "../private-shell";
import OperatorClient from "./operator-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Exomem alpha operator",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ExomemOperatorPage() {
  const price = await loadExomemCloudPrice();
  return (
    <PrivateShell>
      <OperatorClient price={price} />
    </PrivateShell>
  );
}
