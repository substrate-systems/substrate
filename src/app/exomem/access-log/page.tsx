import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accessLogEnabled } from "@/lib/exomem-hosted/cloud-access-log";
import AccessLogClient from "./access-log-client";
import home from "../home/home.module.css";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Exomem access log",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};
export default function AccessLogPage() {
  if (!accessLogEnabled()) notFound();
  return (
    <main className={`${home.page} brand-exomem`}>
      <AccessLogClient />
    </main>
  );
}
