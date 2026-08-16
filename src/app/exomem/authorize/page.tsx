import type { Metadata } from "next";
import { cookies } from "next/headers";
import { PrivateShell } from "../private-shell";
import {
  EXOMEM_OAUTH_FORM_NONCE_COOKIE,
  EXOMEM_OAUTH_CONTINUITY_COOKIE,
  matchesOAuthConfirmationHandle,
  oauthFormNonceFromCookie,
  resolveOAuthContinuationToken,
} from "@/lib/exomem-hosted/oauth-continuity";
import { marketplaceReviewerAccessEnabled } from "@/lib/exomem-hosted/reviewer-access";
import { findExomemSessionByDigest } from "@/lib/exomem-hosted/db";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import AuthorizeClient from "./authorize-client";

// Whether the visitor already has an Exomem is the one fact that decides what
// this page should offer, and it was the one fact the page never established.
// Without it, "Continue" was rendered to everyone -- including someone arriving
// from a connector before they have ever redeemed their invitation, for whom it
// can only ever end in access_denied.
async function visitorIsSignedIn(sessionToken: string | undefined): Promise<boolean> {
  if (!sessionToken) return false;
  const digest = tokenDigest(sessionToken);
  if (!digest) return false;
  try {
    return !!(await findExomemSessionByDigest(digest));
  } catch {
    // Never let a storage failure decide the layout. Presenting the sign-in
    // paths to someone who is in fact signed in costs them one extra click;
    // presenting Continue to someone who is not is a dead end.
    return false;
  }
}

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Authorize Exomem",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function ExomemAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<{ confirmation?: string }>;
}) {
  const cookieStore = await cookies();
  const query = await searchParams;
  const nonce =
    oauthFormNonceFromCookie(cookieStore.get(EXOMEM_OAUTH_FORM_NONCE_COOKIE)?.value) ?? "";
  const transaction = cookieStore.get(EXOMEM_OAUTH_CONTINUITY_COOKIE)?.value;
  const continuation = matchesOAuthConfirmationHandle(transaction, query.confirmation)
    ? await resolveOAuthContinuationToken(transaction)
    : null;
  const canContinue = !!continuation && !!nonce && !!query.confirmation;
  const signedIn = canContinue
    ? await visitorIsSignedIn(cookieStore.get(EXOMEM_SESSION_COOKIE)?.value)
    : false;
  return (
    <PrivateShell>
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-2xl font-semibold">
          {signedIn ? "Connect this app to Exomem" : "Set up your Exomem"}
        </h1>
        <p className="mt-3 text-neutral-600">
          {signedIn
            ? "This app is asking to read and write your Exomem. Confirm below to connect it."
            : "This app wants to connect to Exomem, and you are not signed in on this device yet. Accept your invitation below and we will finish connecting the app for you — you will not need to come back here."}
        </p>
        {canContinue ? (
          <dl className="mt-6 space-y-2 text-sm text-neutral-700">
            <div>
              <dt className="font-medium">Client</dt>
              <dd>{continuation.clientId}</dd>
            </div>
            <div>
              <dt className="font-medium">Requested access</dt>
              <dd>{continuation.scopes.join(", ")}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-6 text-sm text-neutral-600">
            This connection request is no longer active. Start again from the client you want to
            connect.
          </p>
        )}
        {canContinue ? (
          <AuthorizeClient
            confirmation={query.confirmation!}
            nonce={nonce}
            signedIn={signedIn}
            reviewerEnabled={marketplaceReviewerAccessEnabled()}
          />
        ) : null}
      </main>
    </PrivateShell>
  );
}
