import type { Metadata } from "next";
import { PrivateShell } from "../private-shell";
import InviteClient from "./invite-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Accept your Exomem invite",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function InvitePage() {
  return (
    <PrivateShell>
      <InviteClient />
    </PrivateShell>
  );
}
