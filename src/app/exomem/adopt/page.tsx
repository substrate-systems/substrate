import type { Metadata } from "next";
import { PrivateShell } from "../private-shell";
import AdoptClient from "./adopt-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Bring your notes into Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function AdoptPage() {
  return (
    <PrivateShell>
      <AdoptClient />
    </PrivateShell>
  );
}
