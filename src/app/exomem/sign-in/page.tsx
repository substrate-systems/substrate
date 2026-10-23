import type { Metadata } from "next";
import { cookies } from "next/headers";
import { findExomemSessionByDigest } from "@/lib/exomem-hosted/db";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import { marketplaceReviewerAccessEnabled } from "@/lib/exomem-hosted/reviewer-access";
import { statusPageUrl } from "../_journey/status-page";
import SignInClient from "./sign-in-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Sign in to Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function SignInPage() {
  const cookieStore = await cookies();
  const value = cookieStore.get(EXOMEM_SESSION_COOKIE)?.value;
  const digest = value ? tokenDigest(value) : null;
  let existingSessionDestination: "/exomem/home" | null = null;
  if (digest) {
    try {
      if (await findExomemSessionByDigest(digest)) existingSessionDestination = "/exomem/home";
    } catch {
      // A failed optional lookup must not prevent explicit email-link confirmation.
    }
  }
  return (
    <SignInClient
      existingSessionDestination={existingSessionDestination}
      reviewerEnabled={marketplaceReviewerAccessEnabled()}
      statusPageUrl={statusPageUrl()}
    />
  );
}
