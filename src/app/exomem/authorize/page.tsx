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
import { loadOwnerBillingAccount } from "@/lib/exomem-hosted/billing-account";
import { exomemCloudEnabled, loadExomemCloudResource } from "@/lib/exomem-hosted/cloud-config";
import { getOwnerCloudStatus } from "@/lib/exomem-hosted/cloud-status";
import { findExomemSessionByDigest } from "@/lib/exomem-hosted/db";
import { tokenDigest } from "@/lib/exomem-hosted/security";
import { EXOMEM_SESSION_COOKIE } from "@/lib/exomem-hosted/sessions";
import AuthorizeClient from "./authorize-client";
import { type ConsentAccount, type ConsentStep, consentStep } from "./consent-state";

type VisitorAccount = ConsentAccount & { cellStarting: boolean };

// Whether the visitor has an Exomem, and in what state, decides what this page
// offers. Without it, "Continue" was rendered to everyone -- including someone
// arriving from a connector before they have ever redeemed their invitation, or
// before their first payment, for whom it can only ever end in a refusal.
async function visitorAccount(
  sessionToken: string | undefined,
  reviewerCredentialId: string | null
): Promise<VisitorAccount | null> {
  if (!sessionToken) return null;
  const digest = tokenDigest(sessionToken);
  if (!digest) return null;
  try {
    const session = await findExomemSessionByDigest(digest);
    // A reviewer cookie from another connection is not consent authority for
    // this one. Offer fresh reviewer sign-in until its credential is bound.
    if (!session || (session.reviewerCredentialId ?? null) !== reviewerCredentialId) return null;
    const account = await loadOwnerBillingAccount(session.userId, session.tenantId);
    if (!account) return null;
    // Only Cloud reports when a cell is ready, so the hosted path shows no starting note.
    const cellStarting =
      exomemCloudEnabled() && (await getOwnerCloudStatus(session.tenantId)).state !== "ready";
    return {
      effectiveState: account.effectiveState,
      sourceState: account.sourceState,
      cellStarting,
    };
  } catch {
    // Never let a storage failure decide the layout. Presenting the sign-in
    // paths to someone who is in fact signed in costs them one extra click;
    // presenting Continue to someone who is not is a dead end.
    return null;
  }
}

const CONNECT_COPY = {
  title: "Connect this app to Exomem",
  lede: "This app is asking to read and write your Exomem. Confirm below to connect it.",
};

const STEP_COPY: Record<ConsentStep, { title: string; lede: string }> = {
  "sign-in": {
    title: "Connect this app to Exomem",
    lede: "Sign in to connect this app to your Exomem. You will come straight back here.",
  },
  subscribe: {
    title: "Subscribe to finish setting up",
    lede: "Your Exomem is reserved. Subscribe to start it, and then connect this app here.",
  },
  connect: CONNECT_COPY,
  "connect-read-only": CONNECT_COPY,
  ended: {
    title: "Your subscription has ended",
    lede: "Your Exomem is read-only now, so this app cannot connect to it.",
  },
  paused: {
    title: "Your subscription is paused",
    lede: "This app can connect when you resume your subscription.",
  },
  suspended: {
    title: "This Exomem is suspended",
    lede: "This app cannot connect while your Exomem is suspended.",
  },
};

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
  if (!canContinue) {
    return (
      <PrivateShell>
        <main className="mx-auto max-w-xl px-6 py-16">
          <h1 className="text-2xl font-semibold">This connection request has expired</h1>
          <p className="mt-3 text-neutral-600">Start again from the app you want to connect.</p>
        </main>
      </PrivateShell>
    );
  }
  const account = await visitorAccount(
    cookieStore.get(EXOMEM_SESSION_COOKIE)?.value,
    continuation.reviewerCredentialId ?? null
  );
  const step = consentStep(account);
  const copy = STEP_COPY[step];
  return (
    <PrivateShell>
      <main className="mx-auto max-w-xl px-6 py-16">
        <h1 className="text-2xl font-semibold">{copy.title}</h1>
        <p className="mt-3 text-neutral-600">{copy.lede}</p>
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
        <AuthorizeClient
          confirmation={query.confirmation!}
          nonce={nonce}
          step={step}
          cellStarting={account?.cellStarting ?? false}
          reviewerEnabled={
            marketplaceReviewerAccessEnabled() &&
            (!exomemCloudEnabled() || continuation.resource === loadExomemCloudResource().mcpUrl)
          }
        />
      </main>
    </PrivateShell>
  );
}
