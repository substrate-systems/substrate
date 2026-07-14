import type { Metadata } from "next";
import { PrivateShell } from "../private-shell";
import SignInClient from "./sign-in-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Sign in to Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default function SignInPage() {
  return (
    <PrivateShell>
      <SignInClient />
    </PrivateShell>
  );
}
