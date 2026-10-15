import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cloudViewerEnabled } from "@/lib/exomem-hosted/cloud-viewer";
import ViewerClient from "./viewer-client";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Your knowledge · Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function ViewerPage() {
  if (!cloudViewerEnabled()) notFound();
  return <ViewerClient />;
}
