import type { Metadata } from "next";
import { PrivateShell } from "../private-shell";
import DeleteClient from "./delete-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Delete your Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function DeleteExomemPage() {
  return (
    <PrivateShell>
      <DeleteClient />
    </PrivateShell>
  );
}
